// UmiGaugeCluster — 2×2 analog gauge cluster.
// Top row:    LOUDNESS  /  TEMPO
// Bottom row: ENERGY    /  BEAT
//
// Each gauge has a cream face, brass tick marks, an orange redline arc
// at the upper end of the dial, a glass bevel frame, hazard-stripe
// corner accents, and a numeric readout below. Looks like the dash of
// a 70s Volvo crossed with a control-room VU panel.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import {
	binarySearchIndex,
	decibelsToAmplitude,
	sampleSegmentedFunction,
	sampleAccumulatedIntegral,
	smoothstep
} from "../../../utils";
import { UMI_PALETTE, getForceUmiPalette, effectiveAccent } from "./umiPalette";
import {
	drawBevel,
	drawGaugeNeedle,
	drawGaugeTicks,
	drawHazardStripe,
	drawRedlineArc,
	drawScanlines,
	drawVignette,
	roundedRectPath
} from "./drawHelpers";

type CanvasData = {
	loudnessCurve: CurveEntry[];
	tempo: number;
	beats: number[];
	duration: number;
	totalEnergy: number;
	themeColor: Spicetify.Color;
};

type RendererState =
	| { isError: true }
	| {
			isError: false;
			lastBeatIdx: number;
			beatPulseUntil: number; // ms timestamp (performance.now())
	  };

// Gauge dial spans a 240° arc — 8 o'clock to 4 o'clock — so 0 sits left
// of the bottom and full sits right of the bottom (familiar dashboard).
const DIAL_START = Math.PI * 0.75; //  135°
const DIAL_END = Math.PI * 2.25; //   405° -> wraps through 0/right
const DIAL_SPAN = DIAL_END - DIAL_START;
const REDLINE_FROM = 0.78; // start of the orange redline arc (0..1)

export default function UmiGaugeCluster(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);

	const trackData = useMemo<CanvasData | null>(() => {
		if (!props.audioAnalysis) return null;

		const segments = props.audioAnalysis.segments;
		if (segments.length === 0) return null;

		// Build a piecewise-linear loudness amplitude curve through every
		// segment's peak. Reused for the LOUDNESS gauge (instantaneous)
		// AND the ENERGY gauge (cumulative integral).
		const curve: CurveEntry[] = [];
		curve.push({ x: segments[0].start, y: decibelsToAmplitude(segments[0].loudness_start) });
		for (const s of segments) {
			curve.push({
				x: s.start + s.loudness_max_time,
				y: decibelsToAmplitude(s.loudness_max)
			});
		}
		const last = segments[segments.length - 1];
		curve.push({
			x: last.start + last.duration,
			y: decibelsToAmplitude(last.loudness_end)
		});

		// Accumulate integrals so sampleAccumulatedIntegral can short-circuit
		curve[0].accumulatedIntegral = 0;
		for (let i = 1; i < curve.length; i++) {
			const p1 = curve[i - 1];
			const p2 = curve[i];
			const area = -0.5 * (p1.x - p2.x) * (p1.y + p2.y);
			p2.accumulatedIntegral = (p1.accumulatedIntegral ?? 0) + area;
		}

		const totalEnergy = curve[curve.length - 1].accumulatedIntegral ?? 0;

		return {
			loudnessCurve: curve,
			tempo: props.audioAnalysis.track.tempo,
			beats: props.audioAnalysis.beats.map(b => b.start),
			duration: props.audioAnalysis.track.duration,
			totalEnergy,
			themeColor: props.themeColor
		};
	}, [props.audioAnalysis, props.themeColor]);

	const onInit = useCallback((ctx: CanvasRenderingContext2D | null): RendererState => {
		if (!ctx) {
			onError("Error: 2D rendering is not supported", ErrorRecovery.NONE);
			return { isError: true };
		}
		return { isError: false, lastBeatIdx: -1, beatPulseUntil: 0 };
	}, [onError]);

	const onResize = useCallback(() => {}, []);

	const onRender = useCallback(
		(ctx: CanvasRenderingContext2D | null, data: CanvasData | null, state: RendererState) => {
			if (state.isError || !ctx) return;
			const { width, height } = ctx.canvas;

			// --- Background: warm-dark dashboard panel
			const bg = ctx.createLinearGradient(0, 0, 0, height);
			bg.addColorStop(0, UMI_PALETTE.warmDark);
			bg.addColorStop(1, UMI_PALETTE.warmDarkDeep);
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, width, height);

			if (!data) {
				drawVignette(ctx, width, height);
				return;
			}

			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);
			const progress = Spicetify.Player.getProgress() / 1000;

			// --- Read each metric at current playhead
			const inst = Math.min(
				1,
				Math.max(0, sampleSegmentedFunction(data.loudnessCurve, e => e.x, e => e.y, smoothstep, progress))
			);

			const tempoNorm = Math.min(1, data.tempo / 200); // 200 BPM = redline

			const energy = data.totalEnergy > 0
				? Math.min(1, sampleAccumulatedIntegral(data.loudnessCurve, progress) / data.totalEnergy)
				: 0;

			const beatIdx = binarySearchIndex(data.beats, b => b, progress);
			if (beatIdx !== state.lastBeatIdx && beatIdx >= 0) {
				state.lastBeatIdx = beatIdx;
				state.beatPulseUntil = performance.now() + 180;
			}
			const beatPulse = performance.now() < state.beatPulseUntil ? 1 : 0;

			// --- 2×2 layout
			const margin = Math.max(18, Math.round(Math.min(width, height) * 0.04));
			const cellGap = Math.max(10, Math.round(margin * 0.6));
			const cellW = (width - margin * 2 - cellGap) / 2;
			const cellH = (height - margin * 2 - cellGap) / 2;
			const positions = [
				{ x: margin, y: margin },
				{ x: margin + cellW + cellGap, y: margin },
				{ x: margin, y: margin + cellH + cellGap },
				{ x: margin + cellW + cellGap, y: margin + cellH + cellGap }
			];
			const labels = ["LOUDNESS", "TEMPO", "ENERGY", "BEAT"];
			const values = [inst, tempoNorm, energy, beatPulse];
			const readouts = [
				`${(inst * 100).toFixed(0)}%`,
				`${data.tempo.toFixed(1)} BPM`,
				`${(energy * 100).toFixed(0)}%`,
				`${beatIdx + 1} / ${data.beats.length}`
			];

			for (let i = 0; i < 4; i++) {
				const p = positions[i];
				drawGaugeCell(
					ctx,
					p.x,
					p.y,
					cellW,
					cellH,
					labels[i],
					values[i],
					readouts[i],
					accent,
					i === 3 ? beatPulse : 0
				);
			}

			drawScanlines(ctx, width, height, 0.06, 3);
			drawVignette(ctx, width, height, 0.40);
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

// One gauge cell. value ∈ [0,1] drives the needle. beatGlow optionally
// drives a perimeter highlight (used by the BEAT cell on each tick).
function drawGaugeCell(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	label: string,
	value: number,
	readout: string,
	accent: string,
	beatGlow: number
): void {
	// --- Cell bevel frame
	drawBevel(
		ctx,
		x,
		y,
		w,
		h,
		Math.min(14, Math.min(w, h) * 0.06),
		UMI_PALETTE.warmGrey,
		"rgba(255,255,255,0.10)",
		"rgba(0,0,0,0.55)"
	);

	// --- Hazard-tape corner accents (top-left and bottom-right) for UMI flavour
	const cornerSize = Math.min(w, h) * 0.10;
	const stripeWidth = Math.max(4, cornerSize * 0.18);
	ctx.save();
	roundedRectPath(ctx, x, y, w, h, Math.min(14, Math.min(w, h) * 0.06));
	ctx.clip();
	drawHazardStripe(
		ctx,
		x,
		y,
		cornerSize,
		cornerSize * 0.35,
		accent,
		UMI_PALETTE.hazardBlack,
		stripeWidth
	);
	drawHazardStripe(
		ctx,
		x + w - cornerSize,
		y + h - cornerSize * 0.35,
		cornerSize,
		cornerSize * 0.35,
		accent,
		UMI_PALETTE.hazardBlack,
		stripeWidth
	);
	ctx.restore();

	// --- Cream gauge face (slightly inset from the cell)
	const faceMargin = Math.min(w, h) * 0.07;
	const faceX = x + faceMargin;
	const faceY = y + faceMargin;
	const faceW = w - faceMargin * 2;
	const faceH = h - faceMargin * 2;
	const cx = faceX + faceW / 2;
	const cy = faceY + faceH / 2 - faceH * 0.05; // bias up so labels fit below
	const r = Math.min(faceW, faceH) / 2 - 4;

	ctx.save();
	const faceGrad = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
	faceGrad.addColorStop(0, "#fffaea");
	faceGrad.addColorStop(0.7, UMI_PALETTE.cream);
	faceGrad.addColorStop(1, "#d8c89a");
	ctx.fillStyle = faceGrad;
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = "rgba(0,0,0,0.55)";
	ctx.lineWidth = 2;
	ctx.stroke();
	ctx.restore();

	// --- Tick marks
	drawGaugeTicks(ctx, cx, cy, r, DIAL_START, DIAL_END, 40, 5, "rgba(20,9,10,0.75)");

	// --- Redline arc (orange wedge from REDLINE_FROM to 1.0)
	drawRedlineArc(
		ctx,
		cx,
		cy,
		r,
		DIAL_START + DIAL_SPAN * REDLINE_FROM,
		DIAL_END,
		accent
	);

	// --- Centre logo dot (UMI orange)
	ctx.fillStyle = accent;
	ctx.beginPath();
	ctx.arc(cx, cy, r * 0.05, 0, Math.PI * 2);
	ctx.fill();

	// --- Needle
	const v = Math.min(1, Math.max(0, value));
	const angle = DIAL_START + DIAL_SPAN * v;
	const needleColor = v >= REDLINE_FROM ? accent : "#3c2818";
	drawGaugeNeedle(ctx, cx, cy, r * 0.85, angle, needleColor);

	// --- Label + readout (below the dial)
	ctx.save();
	ctx.fillStyle = UMI_PALETTE.cream;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	const labelSize = Math.max(10, Math.round(faceH * 0.07));
	const readoutSize = Math.max(11, Math.round(faceH * 0.09));
	const labelY = y + h - faceMargin - labelSize * 1.3;
	const readoutY = y + h - faceMargin - readoutSize * 0.5;

	ctx.font = `bold ${labelSize}px monospace`;
	ctx.fillStyle = "rgba(251,241,199,0.7)";
	ctx.fillText(label, cx, labelY);

	ctx.font = `bold ${readoutSize}px monospace`;
	ctx.fillStyle = UMI_PALETTE.cream;
	ctx.fillText(readout, cx, readoutY);
	ctx.restore();

	// --- Beat-glow ring (only the BEAT cell) — pulses orange on each tick
	if (beatGlow > 0) {
		ctx.save();
		ctx.strokeStyle = accent;
		ctx.lineWidth = 4;
		ctx.shadowColor = accent;
		ctx.shadowBlur = 16 * beatGlow;
		roundedRectPath(ctx, x + 1, y + 1, w - 2, h - 2, Math.min(14, Math.min(w, h) * 0.06));
		ctx.stroke();
		ctx.restore();
	}
}
