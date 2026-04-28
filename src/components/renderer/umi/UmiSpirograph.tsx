// UmiSpirograph — animated hypotrochoid curve traced in real time
// against a phosphor-decay background. Curve parameters (R, r, d,
// angularSpeed) shift on every Spotify section change, so each
// section paints a fresh rosette over the fading previous one.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import { binarySearchIndex } from "../../../utils";
import { UMI_PALETTE, getForceUmiPalette, effectiveAccent } from "./umiPalette";
import { drawReticle, drawScanlines, drawVignette } from "./drawHelpers";

type CanvasData = {
	beats: number[];
	sections: number[];
	themeColor: Spicetify.Color;
};

type SpiroParams = {
	R: number;
	r: number;
	d: number;
	angularSpeed: number;
};

type RendererState =
	| { isError: true }
	| {
			isError: false;
			lastSectionIdx: number;
			lastBeatIdx: number;
			params: SpiroParams;
			lastPoint: { x: number; y: number } | null;
			beatFlashUntil: number;
	  };

// Deterministic-but-varied parameters per section index.
function paramsForSection(idx: number): SpiroParams {
	const s = Math.abs(idx) + 1;
	// Pick R/r ratios that produce visually distinct rosettes
	const ratios = [
		{ R: 1.0, r: 0.32 },
		{ R: 1.0, r: 0.5 },
		{ R: 1.0, r: 0.27 },
		{ R: 1.0, r: 0.42 },
		{ R: 1.0, r: 0.21 },
		{ R: 1.0, r: 0.55 }
	];
	const pick = ratios[s % ratios.length];
	return {
		R: pick.R,
		r: pick.r,
		d: 0.28 + ((s * 0.07) % 0.32),
		angularSpeed: 0.8 + ((s * 0.13) % 1.4)
	};
}

function spiroPoint(params: SpiroParams, t: number): { x: number; y: number } {
	const { R, r, d } = params;
	const k = (R - r) / r;
	return {
		x: (R - r) * Math.cos(t) + d * Math.cos(k * t),
		y: (R - r) * Math.sin(t) - d * Math.sin(k * t)
	};
}

export default function UmiSpirograph(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);

	const trackData = useMemo<CanvasData | null>(() => {
		if (!props.audioAnalysis) return null;
		return {
			beats: props.audioAnalysis.beats.map(b => b.start),
			sections: props.audioAnalysis.sections.map(s => s.start),
			themeColor: props.themeColor
		};
	}, [props.audioAnalysis, props.themeColor]);

	const onInit = useCallback((ctx: CanvasRenderingContext2D | null): RendererState => {
		if (!ctx) {
			onError("Error: 2D rendering is not supported", ErrorRecovery.NONE);
			return { isError: true };
		}
		ctx.fillStyle = UMI_PALETTE.warmDarkDeep;
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		return {
			isError: false,
			lastSectionIdx: -1,
			lastBeatIdx: -1,
			params: paramsForSection(0),
			lastPoint: null,
			beatFlashUntil: 0
		};
	}, [onError]);

	const onResize = useCallback((ctx: CanvasRenderingContext2D | null) => {
		if (!ctx) return;
		ctx.fillStyle = UMI_PALETTE.warmDarkDeep;
		ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	}, []);

	const onRender = useCallback(
		(
			ctx: CanvasRenderingContext2D | null,
			data: CanvasData | null,
			state: RendererState
		) => {
			if (state.isError || !ctx || !data) return;
			const { width, height } = ctx.canvas;
			const cx = width / 2;
			const cy = height / 2;
			const radius = Math.min(width, height) * 0.42;

			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);
			const progress = Spicetify.Player.getProgress() / 1000;

			// Phosphor decay — translucent dark over previous frame.
			ctx.fillStyle = "rgba(31, 20, 16, 0.07)";
			ctx.fillRect(0, 0, width, height);

			// Section change → reset params + clear trace
			const sectionIdx = binarySearchIndex(data.sections, s => s, progress);
			if (sectionIdx !== state.lastSectionIdx) {
				state.lastSectionIdx = sectionIdx;
				state.params = paramsForSection(sectionIdx);
				state.lastPoint = null;
				// Hard fade so the new rosette stands out
				ctx.fillStyle = "rgba(31, 20, 16, 0.55)";
				ctx.fillRect(0, 0, width, height);
			}

			// Beat detection — flashes a faint reticle ring
			const beatIdx = binarySearchIndex(data.beats, b => b, progress);
			if (beatIdx !== state.lastBeatIdx && beatIdx >= 0) {
				state.lastBeatIdx = beatIdx;
				state.beatFlashUntil = performance.now() + 220;
			}

			// Reticle — barely-visible cream cross/grid behind the trace
			drawReticle(
				ctx,
				cx - radius,
				cy - radius,
				radius * 2,
				radius * 2,
				6,
				"rgba(251,241,199,0.06)"
			);

			// Compute current pen position
			const t = progress * state.params.angularSpeed;
			const pt = spiroPoint(state.params, t);
			const px = cx + pt.x * radius;
			const py = cy + pt.y * radius;

			// Connect from last position to current
			if (state.lastPoint) {
				ctx.lineWidth = 2;
				ctx.lineCap = "round";
				ctx.strokeStyle = accent;
				ctx.shadowColor = accent;
				ctx.shadowBlur = 8;
				ctx.beginPath();
				ctx.moveTo(state.lastPoint.x, state.lastPoint.y);
				ctx.lineTo(px, py);
				ctx.stroke();
				ctx.shadowBlur = 0;

				// Cream highlight every few segments — gives the trace
				// a brushed-metal sheen without doubling the line cost.
				if ((Math.floor(t * 100) & 7) === 0) {
					ctx.lineWidth = 1;
					ctx.strokeStyle = "rgba(251,241,199,0.45)";
					ctx.beginPath();
					ctx.moveTo(state.lastPoint.x, state.lastPoint.y);
					ctx.lineTo(px, py);
					ctx.stroke();
				}
			}
			state.lastPoint = { x: px, y: py };

			// Pen tip
			ctx.fillStyle = UMI_PALETTE.cream;
			ctx.shadowColor = accent;
			ctx.shadowBlur = 10;
			ctx.beginPath();
			ctx.arc(px, py, 3, 0, Math.PI * 2);
			ctx.fill();
			ctx.shadowBlur = 0;

			// Beat-flash ring
			if (performance.now() < state.beatFlashUntil) {
				const remaining = (state.beatFlashUntil - performance.now()) / 220;
				ctx.strokeStyle = `rgba(255,103,0,${remaining * 0.5})`;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(cx, cy, radius * (1 + (1 - remaining) * 0.05), 0, Math.PI * 2);
				ctx.stroke();
			}

			// Track ring (faint cream circle marking the curve bounds)
			ctx.strokeStyle = "rgba(251,241,199,0.10)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(cx, cy, radius, 0, Math.PI * 2);
			ctx.stroke();

			drawScanlines(ctx, width, height, 0.06, 3);
			drawVignette(ctx, width, height, 0.50);
		},
		[]
	);

	return (
		<AnimatedCanvas
			isEnabled={props.isEnabled}
			data={trackData}
			contextType="2d"
			onInit={onInit}
			onResize={onResize}
			onRender={onRender as any}
			style={{ width: "100%", height: "100%" }}
		/>
	);
}
