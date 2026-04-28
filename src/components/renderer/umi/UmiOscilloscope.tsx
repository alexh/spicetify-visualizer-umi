// UmiOscilloscope — phosphor CRT scope. Three rhythm-band channels
// (low/mid/high) traced left-to-right, with phosphor decay achieved
// by alpha-clearing each frame instead of full clear. Cream reticle
// + 1px scanline overlay + edge vignette.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import { UMI_PALETTE, getForceUmiPalette, effectiveAccent } from "./umiPalette";
import { drawReticle, drawScanlines, drawVignette } from "./drawHelpers";
import {
	precomputeRhythm,
	sampleBands,
	downsampleBands,
	type RhythmString
} from "./bandSampler";

const TRACE_RESOLUTION = 256; // horizontal samples per trace
const SAMPLE_WINDOW_SECONDS = 4; // how much history we draw

type CanvasData = {
	rhythm: RhythmString;
	themeColor: Spicetify.Color;
};

type RendererState =
	| { isError: true }
	| {
			isError: false;
			lastT: number;
	  };

export default function UmiOscilloscope(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);

	const rhythm = useMemo(() => {
		if (!props.audioAnalysis) return [] as RhythmString;
		if (props.audioAnalysis.track.rhythm_version !== 1) {
			onError(
				`Error: Unsupported rhythmstring version ${props.audioAnalysis.track.rhythm_version}`,
				ErrorRecovery.SONG_CHANGE
			);
			return [] as RhythmString;
		}
		return precomputeRhythm(props.audioAnalysis.track.rhythmstring);
	}, [props.audioAnalysis, onError]);

	const onInit = useCallback((ctx: CanvasRenderingContext2D | null): RendererState => {
		if (!ctx) {
			onError("Error: 2D rendering is not supported", ErrorRecovery.NONE);
			return { isError: true };
		}
		// Paint solid dark once so the first phosphor blend reads correctly
		ctx.fillStyle = UMI_PALETTE.warmDarkDeep;
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		return { isError: false, lastT: -1 };
	}, [onError]);

	const onResize = useCallback((ctx: CanvasRenderingContext2D | null) => {
		if (!ctx) return;
		ctx.fillStyle = UMI_PALETTE.warmDarkDeep;
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	}, []);

	const onRender = useCallback(
		(
			ctx: CanvasRenderingContext2D | null,
			data: CanvasData,
			state: RendererState
		) => {
			if (state.isError || !ctx) return;
			const { width, height } = ctx.canvas;

			// --- Phosphor decay: blend translucent dark over previous frame
			ctx.fillStyle = "rgba(31, 20, 16, 0.22)";
			ctx.fillRect(0, 0, width, height);

			if (data.rhythm.length === 0) {
				drawVignette(ctx, width, height);
				return;
			}

			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);

			// Reticle behind the trace, dim cream
			const reticleMargin = Math.max(16, Math.round(Math.min(width, height) * 0.04));
			drawReticle(
				ctx,
				reticleMargin,
				reticleMargin,
				width - reticleMargin * 2,
				height - reticleMargin * 2,
				10,
				"rgba(251,241,199,0.10)"
			);

			const progress = Spicetify.Player.getProgress() / 1000;
			const halfWindow = SAMPLE_WINDOW_SECONDS / 2;

			// Three traces — coarse downsample of all rhythm bands into
			// low / mid / high. Each gets its own y-baseline.
			const tracesY = [height * 0.3, height * 0.55, height * 0.8];
			const traceColors = [accent, UMI_PALETTE.cream, UMI_PALETTE.bright];
			const amplitudeScale = height * 0.15;

			for (let traceIdx = 0; traceIdx < 3; traceIdx++) {
				const y0 = tracesY[traceIdx];
				ctx.lineWidth = traceIdx === 0 ? 2 : 1.5;
				ctx.strokeStyle = traceColors[traceIdx];
				ctx.shadowColor = traceColors[traceIdx];
				ctx.shadowBlur = traceIdx === 0 ? 8 : 4;

				ctx.beginPath();
				for (let i = 0; i < TRACE_RESOLUTION; i++) {
					const t = progress - halfWindow + (SAMPLE_WINDOW_SECONDS * i) / (TRACE_RESOLUTION - 1);
					const rawBands = sampleBands(data.rhythm, t);
					if (rawBands.length === 0) break;
					const three = downsampleBands(rawBands, 3);
					const v = three[traceIdx];

					const x = (width * i) / (TRACE_RESOLUTION - 1);
					const y = y0 - v * amplitudeScale;
					if (i === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.stroke();
			}
			ctx.shadowBlur = 0;

			// Centre playhead — bright vertical hairline
			ctx.strokeStyle = "rgba(251,241,199,0.45)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(width / 2, reticleMargin);
			ctx.lineTo(width / 2, height - reticleMargin);
			ctx.stroke();

			// Scope corner labels (lo / mid / hi)
			ctx.fillStyle = "rgba(251,241,199,0.55)";
			ctx.font = `${Math.max(10, Math.round(height * 0.022))}px monospace`;
			ctx.textBaseline = "middle";
			ctx.fillText("LO", reticleMargin + 4, tracesY[0]);
			ctx.fillText("MD", reticleMargin + 4, tracesY[1]);
			ctx.fillText("HI", reticleMargin + 4, tracesY[2]);

			drawScanlines(ctx, width, height, 0.10, 2);
			drawVignette(ctx, width, height, 0.55);

			state.lastT = progress;
		},
		[]
	);

	return (
		<AnimatedCanvas
			isEnabled={props.isEnabled}
			data={{ rhythm, themeColor: props.themeColor }}
			contextType="2d"
			onInit={onInit}
			onResize={onResize}
			onRender={onRender}
			style={{ width: "100%", height: "100%" }}
		/>
	);
}
