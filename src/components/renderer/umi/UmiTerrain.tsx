// UmiTerrain — raw WebGL2 raymarched terrain.
// Mirrors the NCSVisualizer pattern as closely as possible:
// AnimatedCanvas with contextType="webgl2", useCallback'd onInit/
// onResize/onRender that match its expected signatures, all per-frame
// audio sampling done inside onRender from the data prop.

import React, { useCallback, useContext, useMemo } from "react";
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
	return [
		parseInt(full.slice(0, 2), 16) / 255,
		parseInt(full.slice(2, 4), 16) / 255,
		parseInt(full.slice(4, 6), 16) / 255
	];
}

export default function UmiTerrain(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);

	const trackData = useMemo<CanvasData>(() => {
		const def: CanvasData = {
			rhythm: [] as RhythmString,
			beats: [] as number[],
			themeColor: props.themeColor
		};
		if (!props.audioAnalysis) return def;
		return {
			rhythm:
				props.audioAnalysis.track.rhythm_version === 1
					? precomputeRhythm(props.audioAnalysis.track.rhythmstring)
					: ([] as RhythmString),
			beats: props.audioAnalysis.beats.map(b => b.start),
			themeColor: props.themeColor
		};
	}, [props.audioAnalysis, props.themeColor]);

	const onInit = useCallback(
		(gl: WebGL2RenderingContext | null): RendererState => {
			if (!gl) {
				onError("Error: WebGL2 is not supported", ErrorRecovery.NONE);
				return { isError: true };
			}

			const compile = (type: number, src: string, label: string): WebGLShader | null => {
				const sh = gl.createShader(type)!;
				gl.shaderSource(sh, src);
				gl.compileShader(sh);
				if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
					console.error(`[UmiTerrain] ${label} compile error`, gl.getShaderInfoLog(sh));
					onError(`Error: Failed to compile '${label}' shader`, ErrorRecovery.NONE);
					return null;
				}
				return sh;
			};

			const vs = compile(gl.VERTEX_SHADER, TERRAIN_VERT_SHADER, "vertex");
			if (!vs) return { isError: true };
			const fs = compile(gl.FRAGMENT_SHADER, TERRAIN_FRAG_SHADER, "fragment");
			if (!fs) return { isError: true };

			const program = gl.createProgram()!;
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
				console.error("[UmiTerrain] program link error", gl.getProgramInfoLog(program));
				onError("Error: Failed to link terrain program", ErrorRecovery.NONE);
				return { isError: true };
			}

			const quadBuffer = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
				gl.STATIC_DRAW
			);

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
		[onError]
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
			data: CanvasData,
			state: RendererState
		) => {
			if (state.isError || !gl) return;

			// Bail if canvas hasn't been laid out yet. Without this guard
			// uResolution = (0, 0) → shader gets NaN → GPU paints white.
			const w = gl.canvas.width;
			const h = gl.canvas.height;
			if (w < 1 || h < 1) return;

			gl.viewport(0, 0, w, h);
			gl.clearColor(31 / 255, 20 / 255, 16 / 255, 1); // warmDarkDeep
			gl.clear(gl.COLOR_BUFFER_BIT);

			gl.useProgram(state.program);
			gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
			gl.enableVertexAttribArray(state.inPositionLoc);
			gl.vertexAttribPointer(state.inPositionLoc, 2, gl.FLOAT, false, 0, 0);

			const elapsed = (performance.now() - state.startTime) / 1000;
			const rawProgress = Spicetify.Player.getProgress();
			const progress =
				typeof rawProgress === "number" && isFinite(rawProgress)
					? rawProgress / 1000
					: 0;

			const safe = (v: number) => (isFinite(v) ? v : 0);

			let bass = 0,
				mid = 0,
				high = 0;
			if (data.rhythm.length > 0) {
				const raw = sampleBands(data.rhythm, progress);
				const three = downsampleBands(raw, 3);
				bass = safe(three[0] ?? 0);
				mid = safe(three[1] ?? 0);
				high = safe(three[2] ?? 0);
			}

			let beatPulse = 0;
			if (data.beats.length > 0) {
				const idx = binarySearchIndex(data.beats, b => b, progress);
				const beatStart = idx >= 0 && idx < data.beats.length ? data.beats[idx] : 0;
				const phase = Math.max(0, progress - beatStart);
				beatPulse = safe(Math.exp(-phase * 5));
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
