// UmiHazardSpectrum — column bars styled as orange/black diagonal
// hazard tape, one column per (downsampled) rhythm channel.
// Reads playback time directly from Spicetify.Player so it stays
// synced with the player without any analysis-streaming.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import {
	UMI_PALETTE,
	effectiveAccent,
	getForceUmiPalette
} from "./umiPalette";
import {
	drawHazardStripe,
	drawBevel,
	drawScanlines,
	drawVignette
} from "./drawHelpers";
import {
	precomputeRhythm,
	sampleBands,
	downsampleBands,
	type RhythmString
} from "./bandSampler";

const TARGET_BAR_COUNT = 24;

type CanvasData = {
	rhythm: RhythmString;
	themeColor: Spicetify.Color;
};

type RendererState =
	| { isError: true }
	| { isError: false };

export default function UmiHazardSpectrum(props: RendererProps) {
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
		return { isError: false };
	}, [onError]);

	const onResize = useCallback(() => {
		// no-op — sizing handled per-frame
	}, []);

	const onRender = useCallback(
		(ctx: CanvasRenderingContext2D | null, data: CanvasData, state: RendererState) => {
			if (state.isError || !ctx) return;
			const { width, height } = ctx.canvas;

			// Background: warm-dark with a subtle vertical gradient
			const bg = ctx.createLinearGradient(0, 0, 0, height);
			bg.addColorStop(0, UMI_PALETTE.warmDark);
			bg.addColorStop(1, UMI_PALETTE.warmDarkDeep);
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, width, height);

			if (data.rhythm.length === 0) {
				drawVignette(ctx, width, height);
				return;
			}

			const accent = getForceUmiPalette() ? UMI_PALETTE.orange : effectiveAccent(data.themeColor);
			const stripeBlack = UMI_PALETTE.hazardBlack;

			const progress = Spicetify.Player.getProgress() / 1000;
			const rawBands = sampleBands(data.rhythm, progress);
			const bands = downsampleBands(rawBands, TARGET_BAR_COUNT);

			// Layout: columns with margins, anchored to baseline
			const margin = Math.max(12, Math.round(width * 0.02));
			const baseY = height - margin;
			const topY = margin;
			const usableHeight = baseY - topY;

			const slotWidth = (width - margin * 2) / bands.length;
			const barWidth = slotWidth * 0.62;
			const stripeWidth = Math.max(8, Math.round(barWidth * 0.35));

			for (let i = 0; i < bands.length; i++) {
				const x = margin + slotWidth * i + (slotWidth - barWidth) / 2;
				const v = Math.min(1, Math.max(0, bands[i]));
				// Floor so quiet beats still show as a thin tape strip
				const h = Math.max(barWidth * 0.22, v * usableHeight);
				const y = baseY - h;

				// Hazard tape body
				drawHazardStripe(ctx, x, y, barWidth, h, accent, stripeBlack, stripeWidth);

				// Glass-bevel cap on top to feel like a physical strip
				drawBevel(
					ctx,
					x,
					y - 2,
					barWidth,
					6,
					3,
					"rgba(251,241,199,0.18)",
					"rgba(255,255,255,0.30)",
					"rgba(0,0,0,0.40)"
				);

				// Subtle inner shadow at the bottom — anchors bar to baseline
				ctx.save();
				const shadow = ctx.createLinearGradient(0, baseY - 12, 0, baseY);
				shadow.addColorStop(0, "rgba(0,0,0,0)");
				shadow.addColorStop(1, "rgba(0,0,0,0.55)");
				ctx.fillStyle = shadow;
				ctx.fillRect(x, baseY - 12, barWidth, 12);
				ctx.restore();
			}

			// Baseline rule (thin cream line under bars)
			ctx.strokeStyle = "rgba(251,241,199,0.35)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(margin, baseY + 0.5);
			ctx.lineTo(width - margin, baseY + 0.5);
			ctx.stroke();

			drawScanlines(ctx, width, height, 0.08, 3);
			drawVignette(ctx, width, height, 0.45);
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
