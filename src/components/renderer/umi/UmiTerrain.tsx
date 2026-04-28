// UmiTerrain — raw WebGL2 raymarched terrain. Mirrors the upstream
// NCSVisualizer pattern (createShader / createProgram / fullscreen
// quad / per-frame uniforms) so we don't drag three.js into the
// spicetify-creator bundle.

import React, { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import { binarySearchIndex } from "../../../utils";
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

type CanvasData = {
	rhythm: RhythmString;
	beats: number[];
	themeColor: Spicetify.Color;
};

type RendererState =
	| { isError: true }
	| {
			isError: false;
			program: WebGLProgram;
			quadBuffer: WebGLBuffer;
			inPositionLoc: number;
			uTimeLoc: WebGLUniformLocation | null;
			uBassLoc: WebGLUniformLocation | null;
			uMidLoc: WebGLUniformLocation | null;
			uHighLoc: WebGLUniformLocation | null;
			uBeatPulseLoc: WebGLUniformLocation | null;
			uResolutionLoc: WebGLUniformLocation | null;
			uAccentLoc: WebGLUniformLocation | null;
			uCreamLoc: WebGLUniformLocation | null;
			uDarkLoc: WebGLUniformLocation | null;
			startTime: number;
	  };

function hexToRgbF(hex: string): [number, number, number] {
	const h = hex.replace(/^#/, "");
	const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
	const r = parseInt(full.slice(0, 2), 16) / 255;
	const g = parseInt(full.slice(2, 4), 16) / 255;
	const b = parseInt(full.slice(4, 6), 16) / 255;
	return [r, g, b];
}

export default function UmiTerrain(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);
	// Stable ref so onInit/onResize/onRender stay reference-stable across
	// re-renders. Without this, AnimatedCanvas's init effect (deps:
	// [contextType, onInit]) would re-fire whenever React provides a new
	// onError reference and call gl.getContext again, sometimes with a
	// transient null on song-change reconciliation.
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onErrorRef.current = onError;
	}, [onError]);

	const trackData = useMemo<CanvasData | null>(() => {
		if (!props.audioAnalysis) return null;
		const rhythm =
			props.audioAnalysis.track.rhythm_version === 1
				? precomputeRhythm(props.audioAnalysis.track.rhythmstring)
				: ([] as RhythmString);
		return {
			rhythm,
			beats: props.audioAnalysis.beats.map(b => b.start),
			themeColor: props.themeColor
		};
	}, [props.audioAnalysis, props.themeColor]);

	const onInit = useCallback(
		(gl: WebGL2RenderingContext | null): RendererState => {
			if (!gl) {
				// Transient null can happen on song change as React re-runs
				// the AnimatedCanvas effects; treat it as a recoverable blip
				// and bail silently. The next reconcile will give us a real
				// context and re-init. Only true initial-mount failure would
				// indicate WebGL2 isn't supported, and that's rare enough on
				// Spotify's Chromium that we just log to the console.
				console.warn("[UmiTerrain] gl context unavailable at init");
				return { isError: true };
			}

			const compile = (type: number, source: string, name: string): WebGLShader | null => {
				const sh = gl.createShader(type)!;
				gl.shaderSource(sh, source);
				gl.compileShader(sh);
				if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
					const log = gl.getShaderInfoLog(sh);
					console.error(`[UmiTerrain] '${name}' shader compile error`, log);
					onErrorRef.current(`Error: Failed to compile '${name}' shader`, ErrorRecovery.SONG_CHANGE);
					return null;
				}
				return sh;
			};

			const link = (vs: WebGLShader, fs: WebGLShader): WebGLProgram | null => {
				const p = gl.createProgram()!;
				gl.attachShader(p, vs);
				gl.attachShader(p, fs);
				gl.linkProgram(p);
				if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
					const log = gl.getProgramInfoLog(p);
					console.error(`[UmiTerrain] program link error`, log);
					onErrorRef.current("Error: Failed to link terrain shader program", ErrorRecovery.SONG_CHANGE);
					return null;
				}
				return p;
			};

			const vs = compile(gl.VERTEX_SHADER, TERRAIN_VERT_SHADER, "terrain vertex");
			if (!vs) return { isError: true };
			const fs = compile(gl.FRAGMENT_SHADER, TERRAIN_FRAG_SHADER, "terrain fragment");
			if (!fs) return { isError: true };
			const program = link(vs, fs);
			if (!program) return { isError: true };

			const quadBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
			// prettier-ignore
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
				-1, -1,
				 1, -1,
				-1,  1,
				 1,  1
			]), gl.STATIC_DRAW);

			return {
				isError: false,
				program,
				quadBuffer,
				inPositionLoc: gl.getAttribLocation(program, "inPosition"),
				uTimeLoc: gl.getUniformLocation(program, "uTime"),
				uBassLoc: gl.getUniformLocation(program, "uBass"),
				uMidLoc: gl.getUniformLocation(program, "uMid"),
				uHighLoc: gl.getUniformLocation(program, "uHigh"),
				uBeatPulseLoc: gl.getUniformLocation(program, "uBeatPulse"),
				uResolutionLoc: gl.getUniformLocation(program, "uResolution"),
				uAccentLoc: gl.getUniformLocation(program, "uAccent"),
				uCreamLoc: gl.getUniformLocation(program, "uCream"),
				uDarkLoc: gl.getUniformLocation(program, "uDark"),
				startTime: performance.now()
			};
		},
		[]
	);

	const onResize = useCallback(
		(gl: WebGL2RenderingContext | null, state: RendererState) => {
			if (state.isError || !gl) return;
			gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		},
		[]
	);

	const onRender = useCallback(
		(
			gl: WebGL2RenderingContext | null,
			data: CanvasData | null,
			state: RendererState
		) => {
			if (state.isError || !gl || !data) return;

			gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);

			gl.useProgram(state.program);

			gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
			gl.enableVertexAttribArray(state.inPositionLoc);
			gl.vertexAttribPointer(state.inPositionLoc, 2, gl.FLOAT, false, 0, 0);

			const elapsed = (performance.now() - state.startTime) / 1000;
			const progress = Spicetify.Player.getProgress() / 1000;

			let bass = 0, mid = 0, high = 0;
			if (data.rhythm.length > 0) {
				const raw = sampleBands(data.rhythm, progress);
				const three = downsampleBands(raw, 3);
				bass = three[0] ?? 0;
				mid = three[1] ?? 0;
				high = three[2] ?? 0;
			}

			let beatPulse = 0;
			if (data.beats.length > 0) {
				const idx = binarySearchIndex(data.beats, b => b, progress);
				const beatStart = idx >= 0 && idx < data.beats.length ? data.beats[idx] : 0;
				const phase = Math.max(0, progress - beatStart);
				beatPulse = Math.exp(-phase * 5);
			}

			const accentHex = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);
			const accent = hexToRgbF(accentHex);
			const cream = hexToRgbF(UMI_PALETTE.cream);
			const dark = hexToRgbF(UMI_PALETTE.warmDarkDeep);

			gl.uniform1f(state.uTimeLoc, elapsed);
			gl.uniform1f(state.uBassLoc, bass);
			gl.uniform1f(state.uMidLoc, mid);
			gl.uniform1f(state.uHighLoc, high);
			gl.uniform1f(state.uBeatPulseLoc, beatPulse);
			gl.uniform2f(state.uResolutionLoc, gl.canvas.width, gl.canvas.height);
			gl.uniform3f(state.uAccentLoc, accent[0], accent[1], accent[2]);
			gl.uniform3f(state.uCreamLoc, cream[0], cream[1], cream[2]);
			gl.uniform3f(state.uDarkLoc, dark[0], dark[1], dark[2]);

			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		},
		[]
	);

	return (
		<AnimatedCanvas
			isEnabled={props.isEnabled}
			data={trackData}
			contextType="webgl2"
			onInit={onInit}
			onResize={onResize}
			onRender={onRender as any}
			style={{ width: "100%", height: "100%" }}
		/>
	);
}
