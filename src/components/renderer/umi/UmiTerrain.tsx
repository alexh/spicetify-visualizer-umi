// UmiTerrain — raw WebGL2 raymarched terrain.
// Self-managed lifecycle (no AnimatedCanvas) with hardening for the
// song-change white-screen issue:
//   - JSX <canvas> (React owns the DOM node, no reconciliation)
//   - preserveDrawingBuffer: true (last good frame survives composite)
//   - alpha: false (canvas is opaque to the compositor)
//   - webglcontextlost / webglcontextrestored handlers (re-init on loss)
//   - frame inputs piped through a ref (no GL teardown on prop changes)
//   - opaque CSS background as a last-ditch backstop
//   - viewport / resolution NaN guards in the shader and JS

import React, { useEffect, useMemo, useRef } from "react";
import { binarySearchIndex } from "../../../utils";
import { RendererProps } from "../../../app";
import {
	UMI_PALETTE,
	getForceUmiPalette,
	effectiveAccent
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
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

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

	const frameRef = useRef<FrameInputs>({
		rhythm: rhythmData.rhythm,
		beats: rhythmData.beats,
		themeColor: props.themeColor
	});
	useEffect(() => {
		frameRef.current = {
			rhythm: rhythmData.rhythm,
			beats: rhythmData.beats,
			themeColor: props.themeColor
		};
	}, [rhythmData, props.themeColor]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const win = canvas.ownerDocument.defaultView;
		if (!win) return;

		// Build GL state. Wrapped in a function so context-restored
		// can re-run it after a context-loss event.
		type GLState = {
			gl: WebGL2RenderingContext;
			program: WebGLProgram;
			quadBuffer: WebGLBuffer;
			vs: WebGLShader;
			fs: WebGLShader;
			locs: {
				inPosition: number;
				uTime: WebGLUniformLocation | null;
				uBass: WebGLUniformLocation | null;
				uMid: WebGLUniformLocation | null;
				uHigh: WebGLUniformLocation | null;
				uBeatPulse: WebGLUniformLocation | null;
				uResolution: WebGLUniformLocation | null;
				uAccent: WebGLUniformLocation | null;
				uCream: WebGLUniformLocation | null;
				uDark: WebGLUniformLocation | null;
			};
			startTime: number;
		};

		let glState: GLState | null = null;

		const buildGL = (): GLState | null => {
			const gl = canvas.getContext("webgl2", {
				alpha: false,
				antialias: false,
				depth: false,
				stencil: false,
				preserveDrawingBuffer: true,
				powerPreference: "default"
			}) as WebGL2RenderingContext | null;
			if (!gl) {
				console.error("[UmiTerrain] WebGL2 context unavailable");
				return null;
			}

			const compile = (type: number, src: string, label: string): WebGLShader | null => {
				const sh = gl.createShader(type)!;
				gl.shaderSource(sh, src);
				gl.compileShader(sh);
				if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
					console.error(`[UmiTerrain] ${label} shader compile error`, gl.getShaderInfoLog(sh));
					return null;
				}
				return sh;
			};

			const vs = compile(gl.VERTEX_SHADER, TERRAIN_VERT_SHADER, "vertex");
			const fs = compile(gl.FRAGMENT_SHADER, TERRAIN_FRAG_SHADER, "fragment");
			if (!vs || !fs) return null;

			const program = gl.createProgram()!;
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
				console.error("[UmiTerrain] program link error", gl.getProgramInfoLog(program));
				return null;
			}

			const quadBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
				gl.STATIC_DRAW
			);

			return {
				gl,
				program,
				quadBuffer,
				vs,
				fs,
				locs: {
					inPosition: gl.getAttribLocation(program, "inPosition"),
					uTime: gl.getUniformLocation(program, "uTime"),
					uBass: gl.getUniformLocation(program, "uBass"),
					uMid: gl.getUniformLocation(program, "uMid"),
					uHigh: gl.getUniformLocation(program, "uHigh"),
					uBeatPulse: gl.getUniformLocation(program, "uBeatPulse"),
					uResolution: gl.getUniformLocation(program, "uResolution"),
					uAccent: gl.getUniformLocation(program, "uAccent"),
					uCream: gl.getUniformLocation(program, "uCream"),
					uDark: gl.getUniformLocation(program, "uDark")
				},
				startTime: performance.now()
			};
		};

		glState = buildGL();

		// Context-loss recovery
		const handleLost = (e: Event) => {
			e.preventDefault();
			console.warn("[UmiTerrain] webgl context lost");
			glState = null;
		};
		const handleRestored = () => {
			console.warn("[UmiTerrain] webgl context restored");
			glState = buildGL();
		};
		canvas.addEventListener("webglcontextlost", handleLost);
		canvas.addEventListener("webglcontextrestored", handleRestored);

		// DPR-aware sizing
		const updateSize = () => {
			const dpr = Math.min(2, win.devicePixelRatio || 1);
			const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
			const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
			}
		};
		const ro = new win.ResizeObserver(updateSize);
		ro.observe(canvas);
		updateSize();

		// Static palette uniforms
		const cream = hexToRgbF(UMI_PALETTE.cream);
		const dark = hexToRgbF(UMI_PALETTE.warmDarkDeep);

		const safe = (v: number) => (isFinite(v) ? v : 0);

		// Render loop
		let frameId = 0;
		const tick = () => {
			frameId = win.requestAnimationFrame(tick);

			const s = glState;
			if (!s) return;
			const { gl, program, quadBuffer, locs } = s;
			if (gl.isContextLost()) return;

			const w = canvas.width;
			const h = canvas.height;
			if (w < 1 || h < 1) return;

			gl.viewport(0, 0, w, h);
			gl.clearColor(31 / 255, 20 / 255, 16 / 255, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);

			gl.useProgram(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
			gl.enableVertexAttribArray(locs.inPosition);
			gl.vertexAttribPointer(locs.inPosition, 2, gl.FLOAT, false, 0, 0);

			const f = frameRef.current;
			const elapsed = (performance.now() - s.startTime) / 1000;
			const rawProg = Spicetify.Player.getProgress();
			const progress =
				typeof rawProg === "number" && isFinite(rawProg) ? rawProg / 1000 : 0;

			let bass = 0,
				mid = 0,
				high = 0;
			if (f.rhythm.length > 0) {
				const raw = sampleBands(f.rhythm, progress);
				const three = downsampleBands(raw, 3);
				bass = safe(three[0] ?? 0);
				mid = safe(three[1] ?? 0);
				high = safe(three[2] ?? 0);
			}

			let beatPulse = 0;
			if (f.beats.length > 0) {
				const idx = binarySearchIndex(f.beats, b => b, progress);
				const beatStart = idx >= 0 && idx < f.beats.length ? f.beats[idx] : 0;
				const phase = Math.max(0, progress - beatStart);
				beatPulse = safe(Math.exp(-phase * 5));
			}

			const accent = hexToRgbF(
				getForceUmiPalette() ? UMI_PALETTE.orange : effectiveAccent(f.themeColor)
			);

			gl.uniform1f(locs.uTime, elapsed);
			gl.uniform1f(locs.uBass, bass);
			gl.uniform1f(locs.uMid, mid);
			gl.uniform1f(locs.uHigh, high);
			gl.uniform1f(locs.uBeatPulse, beatPulse);
			gl.uniform2f(locs.uResolution, w, h);
			gl.uniform3f(locs.uAccent, accent[0], accent[1], accent[2]);
			gl.uniform3f(locs.uCream, cream[0], cream[1], cream[2]);
			gl.uniform3f(locs.uDark, dark[0], dark[1], dark[2]);

			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		};
		frameId = win.requestAnimationFrame(tick);

		return () => {
			if (frameId) win.cancelAnimationFrame(frameId);
			ro.disconnect();
			canvas.removeEventListener("webglcontextlost", handleLost);
			canvas.removeEventListener("webglcontextrestored", handleRestored);
			if (glState) {
				const { gl, program, quadBuffer, vs, fs } = glState;
				if (!gl.isContextLost()) {
					gl.deleteProgram(program);
					gl.deleteShader(vs);
					gl.deleteShader(fs);
					gl.deleteBuffer(quadBuffer);
				}
			}
		};
	}, []);

	return (
		<canvas
			ref={canvasRef}
			style={{
				width: "100%",
				height: "100%",
				display: "block",
				position: "absolute",
				inset: 0,
				background: UMI_PALETTE.warmDarkDeep
			}}
		/>
	);
}
