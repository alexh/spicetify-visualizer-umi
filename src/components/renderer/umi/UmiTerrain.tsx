// UmiTerrain — raw WebGL2 raymarched terrain.
//
// Bypasses AnimatedCanvas: spawns its own canvas + GL context once at
// mount and never re-inits across prop changes. Audio data flows through
// a ref so the long-lived render loop reads current values without
// triggering React effect cycles. This keeps GL state alive through
// song changes (which used to tear down the context via AnimatedCanvas's
// render-effect reconciliation).

import React, { useEffect, useMemo, useRef } from "react";
import { binarySearchIndex } from "../../../utils";
import { RendererProps } from "../../../app";
import {
	UMI_PALETTE,
	getForceUmiPalette,
	effectiveAccent,
	subscribeForceUmiPalette
} from "./umiPalette";
import {
	precomputeRhythm,
	sampleBands,
	downsampleBands,
	type RhythmString
} from "./bandSampler";
import {
	vertexShader as TERRAIN_VERT_SHADER,
	fragmentShader as TERRAIN_FRAG_SHADER
} from "../../../shaders/umi-terrain/terrain";

type FrameInputs = {
	rhythm: RhythmString;
	beats: number[];
	themeColor: Spicetify.Color;
	isEnabled: boolean;
};

function hexToRgbF(hex: string): [number, number, number] {
	const h = hex.replace(/^#/, "");
	const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
	return [
		parseInt(full.slice(0, 2), 16) / 255,
		parseInt(full.slice(2, 4), 16) / 255,
		parseInt(full.slice(4, 6), 16) / 255
	];
}

export default function UmiTerrain(props: RendererProps) {
	// Canvas is rendered as a JSX element so React owns it and won't
	// strip it out on re-render (which is what happened when we
	// appendChild'd it manually into a parent div — React reconciled
	// the div's children to the empty JSX children list and the
	// canvas vanished after the first re-render).
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	// Per-track precomputation. Same memoisation, but the renderer
	// reads it through a ref so changes don't re-trigger the GL setup.
	const rhythmData = useMemo(() => {
		if (!props.audioAnalysis) {
			return { rhythm: [] as RhythmString, beats: [] as number[] };
		}
		return {
			rhythm:
				props.audioAnalysis.track.rhythm_version === 1
					? precomputeRhythm(props.audioAnalysis.track.rhythmstring)
					: ([] as RhythmString),
			beats: props.audioAnalysis.beats.map(b => b.start)
		};
	}, [props.audioAnalysis]);

	// Frame inputs ref — render loop reads from here without effect deps
	const frameRef = useRef<FrameInputs>({
		rhythm: rhythmData.rhythm,
		beats: rhythmData.beats,
		themeColor: props.themeColor,
		isEnabled: props.isEnabled
	});
	useEffect(() => {
		frameRef.current = {
			rhythm: rhythmData.rhythm,
			beats: rhythmData.beats,
			themeColor: props.themeColor,
			isEnabled: props.isEnabled
		};
	}, [rhythmData, props.themeColor, props.isEnabled]);

	// One-time GL setup, animation loop, cleanup. Empty deps — runs
	// exactly once on mount, tears down exactly once on unmount.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const win = canvas.ownerDocument.defaultView;
		if (!win) return;

		const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
		if (!gl) {
			console.error("[UmiTerrain] WebGL2 not supported in this canvas");
			return;
		}

		// --- shader setup helpers ---
		const compile = (type: number, src: string, label: string): WebGLShader | null => {
			const sh = gl.createShader(type)!;
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
				console.error(`[UmiTerrain] ${label} compile error`, gl.getShaderInfoLog(sh));
				return null;
			}
			return sh;
		};

		const vs = compile(gl.VERTEX_SHADER, TERRAIN_VERT_SHADER, "vertex");
		const fs = compile(gl.FRAGMENT_SHADER, TERRAIN_FRAG_SHADER, "fragment");
		if (!vs || !fs) return;

		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
			console.error("[UmiTerrain] program link error", gl.getProgramInfoLog(program));
			return;
		}

		// Uniform + attribute locations (cached once)
		const inPositionLoc = gl.getAttribLocation(program, "inPosition");
		const uTimeLoc = gl.getUniformLocation(program, "uTime");
		const uBassLoc = gl.getUniformLocation(program, "uBass");
		const uMidLoc = gl.getUniformLocation(program, "uMid");
		const uHighLoc = gl.getUniformLocation(program, "uHigh");
		const uBeatPulseLoc = gl.getUniformLocation(program, "uBeatPulse");
		const uResolutionLoc = gl.getUniformLocation(program, "uResolution");
		const uAccentLoc = gl.getUniformLocation(program, "uAccent");
		const uCreamLoc = gl.getUniformLocation(program, "uCream");
		const uDarkLoc = gl.getUniformLocation(program, "uDark");

		// Fullscreen quad
		const quadBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
			gl.STATIC_DRAW
		);

		// Static palette uniforms
		const cream = hexToRgbF(UMI_PALETTE.cream);
		const dark = hexToRgbF(UMI_PALETTE.warmDarkDeep);

		// Resize observer keeps the canvas crisp
		const updateSize = () => {
			const dpr = Math.min(2, win.devicePixelRatio || 1);
			const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
			const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
			}
			gl.viewport(0, 0, canvas.width, canvas.height);
		};
		const ro = new win.ResizeObserver(updateSize);
		ro.observe(canvas);
		updateSize();

		// Palette toggle hook — re-computes accent at draw time anyway,
		// but we still subscribe to force a repaint feel.
		const unsubPalette = subscribeForceUmiPalette(() => {
			/* repaint happens next frame regardless */
		});

		// --- render loop ---
		let frameId = 0;
		const start = performance.now();

		const tick = () => {
			const f = frameRef.current;

			if (!gl.isContextLost()) {
				gl.viewport(0, 0, canvas.width, canvas.height);
				gl.clearColor(0, 0, 0, 1);
				gl.clear(gl.COLOR_BUFFER_BIT);

				gl.useProgram(program);
				gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
				gl.enableVertexAttribArray(inPositionLoc);
				gl.vertexAttribPointer(inPositionLoc, 2, gl.FLOAT, false, 0, 0);

				const elapsed = (performance.now() - start) / 1000;
				const progress = Spicetify.Player.getProgress() / 1000;

				let bass = 0,
					mid = 0,
					high = 0;
				if (f.rhythm.length > 0) {
					const raw = sampleBands(f.rhythm, progress);
					const three = downsampleBands(raw, 3);
					bass = three[0] ?? 0;
					mid = three[1] ?? 0;
					high = three[2] ?? 0;
				}

				let beatPulse = 0;
				if (f.beats.length > 0) {
					const idx = binarySearchIndex(f.beats, b => b, progress);
					const beatStart = idx >= 0 && idx < f.beats.length ? f.beats[idx] : 0;
					const phase = Math.max(0, progress - beatStart);
					beatPulse = Math.exp(-phase * 5);
				}

				const accentHex = getForceUmiPalette()
					? UMI_PALETTE.orange
					: effectiveAccent(f.themeColor);
				const accent = hexToRgbF(accentHex);

				gl.uniform1f(uTimeLoc, elapsed);
				gl.uniform1f(uBassLoc, bass);
				gl.uniform1f(uMidLoc, mid);
				gl.uniform1f(uHighLoc, high);
				gl.uniform1f(uBeatPulseLoc, beatPulse);
				gl.uniform2f(uResolutionLoc, canvas.width, canvas.height);
				gl.uniform3f(uAccentLoc, accent[0], accent[1], accent[2]);
				gl.uniform3f(uCreamLoc, cream[0], cream[1], cream[2]);
				gl.uniform3f(uDarkLoc, dark[0], dark[1], dark[2]);

				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			}

			frameId = win.requestAnimationFrame(tick);
		};
		frameId = win.requestAnimationFrame(tick);

		return () => {
			if (frameId) win.cancelAnimationFrame(frameId);
			ro.disconnect();
			unsubPalette();
			gl.deleteProgram(program);
			gl.deleteShader(vs);
			gl.deleteShader(fs);
			gl.deleteBuffer(quadBuffer);
		};
	}, []);

	return (
		<canvas
			ref={canvasRef}
			style={{
				width: "100%",
				height: "100%",
				display: "block",
				background: UMI_PALETTE.warmDarkDeep
			}}
		/>
	);
}
