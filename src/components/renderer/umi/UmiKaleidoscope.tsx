// UmiKaleidoscope — N-fold mirrored wedge over a UMI motif of orbiting
// orange/cream dots, beat-driven halo arcs, and a bass-pulsing core.
// Mirror count flips between {6,8,10,12} on every Spotify section
// change, slowly rotating to keep things hypnotic. Pure Canvas2D.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import { binarySearchIndex } from "../../../utils";
import { UMI_PALETTE, getForceUmiPalette, effectiveAccent } from "./umiPalette";
import { drawVignette } from "./drawHelpers";
import {
	precomputeRhythm,
	sampleBands,
	downsampleBands,
	type RhythmString
} from "./bandSampler";

const MIRROR_OPTIONS = [6, 8, 10, 12];

type CanvasData = {
	rhythm: RhythmString;
	beats: number[];
	sections: number[];
	themeColor: Spicetify.Color;
};

type RendererState =
	| { isError: true }
	| {
			isError: false;
			lastBeatIdx: number;
			lastSectionIdx: number;
			mirrorCount: number;
			rotation: number;
	  };

export default function UmiKaleidoscope(props: RendererProps) {
	const onError = useContext(ErrorHandlerContext);

	const trackData = useMemo<CanvasData | null>(() => {
		if (!props.audioAnalysis) return null;
		if (props.audioAnalysis.track.rhythm_version !== 1) {
			onError(
				`Error: Unsupported rhythmstring version ${props.audioAnalysis.track.rhythm_version}`,
				ErrorRecovery.SONG_CHANGE
			);
			return null;
		}
		return {
			rhythm: precomputeRhythm(props.audioAnalysis.track.rhythmstring),
			beats: props.audioAnalysis.beats.map(b => b.start),
			sections: props.audioAnalysis.sections.map(s => s.start),
			themeColor: props.themeColor
		};
	}, [props.audioAnalysis, props.themeColor, onError]);

	const onInit = useCallback((ctx: CanvasRenderingContext2D | null): RendererState => {
		if (!ctx) {
			onError("Error: 2D rendering is not supported", ErrorRecovery.NONE);
			return { isError: true };
		}
		return {
			isError: false,
			lastBeatIdx: -1,
			lastSectionIdx: -1,
			mirrorCount: 8,
			rotation: 0
		};
	}, [onError]);

	const onResize = useCallback(() => {}, []);

	const onRender = useCallback(
		(
			ctx: CanvasRenderingContext2D | null,
			data: CanvasData | null,
			state: RendererState,
			time: number
		) => {
			if (state.isError || !ctx || !data) return;
			const { width, height } = ctx.canvas;

			// Slow ambient rotation
			state.rotation = (time * 0.00012) % (Math.PI * 2);

			// Background
			ctx.fillStyle = UMI_PALETTE.warmDarkDeep;
			ctx.fillRect(0, 0, width, height);

			if (data.rhythm.length === 0) {
				drawVignette(ctx, width, height);
				return;
			}

			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);

			const progress = Spicetify.Player.getProgress() / 1000;

			// Mirror count flips per section
			const sectionIdx = binarySearchIndex(data.sections, s => s, progress);
			if (sectionIdx !== state.lastSectionIdx) {
				state.lastSectionIdx = sectionIdx;
				state.mirrorCount = MIRROR_OPTIONS[Math.abs(sectionIdx) % MIRROR_OPTIONS.length];
			}
			const N = state.mirrorCount;

			// Beat pulse — exponentially decays over ~half a second
			const beatIdx = binarySearchIndex(data.beats, b => b, progress);
			const beatStart = beatIdx >= 0 && beatIdx < data.beats.length ? data.beats[beatIdx] : 0;
			const beatPhase = Math.max(0, progress - beatStart);
			const beatPulse = Math.exp(-beatPhase * 6);

			// Pre-sampled bands for this frame
			const bandsRaw = sampleBands(data.rhythm, progress);
			const bands = downsampleBands(bandsRaw, 6);

			const cx = width / 2;
			const cy = height / 2;
			const R = Math.hypot(width, height) * 0.55;

			for (let i = 0; i < N; i++) {
				ctx.save();
				ctx.translate(cx, cy);
				ctx.rotate((i * 2 * Math.PI) / N + state.rotation);
				if (i % 2 === 1) ctx.scale(-1, 1);

				// Wedge clip
				ctx.beginPath();
				ctx.moveTo(0, 0);
				const wedgeHalf = Math.PI / N;
				ctx.arc(0, 0, R, -wedgeHalf, wedgeHalf);
				ctx.closePath();
				ctx.clip();

				drawMotif(ctx, R, bands, beatPulse, accent, time);
				ctx.restore();
			}

			drawVignette(ctx, width, height, 0.55);
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

function drawMotif(
	ctx: CanvasRenderingContext2D,
	R: number,
	bands: number[],
	beatPulse: number,
	accent: string,
	time: number
): void {
	// 1. Bass-driven core — sits near origin, throbs on every beat.
	const bass = bands[0] ?? 0;
	const coreR = R * (0.04 + bass * 0.07 + beatPulse * 0.04);
	const coreGrad = ctx.createRadialGradient(R * 0.06, 0, 0, R * 0.06, 0, coreR);
	coreGrad.addColorStop(0, "rgba(255,210,150,0.95)");
	coreGrad.addColorStop(0.5, accent);
	coreGrad.addColorStop(1, "rgba(255,103,0,0)");
	ctx.fillStyle = coreGrad;
	ctx.beginPath();
	ctx.arc(R * 0.06, 0, coreR, 0, Math.PI * 2);
	ctx.fill();

	// 2. Orbit dots — each rhythm band drives a satellite at a different
	//    radius. Slow rotation modulated by absolute clock so motion
	//    keeps going even when audio is steady.
	const orbitT = time * 0.0007;
	for (let i = 0; i < bands.length; i++) {
		const v = bands[i];
		const orbitR = R * (0.16 + i * 0.10);
		const phase = orbitT * (1 + i * 0.18) + i * 0.5;
		const px = Math.cos(phase) * orbitR;
		const py = Math.sin(phase * 0.6) * orbitR * 0.55;

		// Spoke from origin
		ctx.strokeStyle = `rgba(251,241,199,${0.10 + v * 0.30})`;
		ctx.lineWidth = 1 + v * 2;
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(px, py);
		ctx.stroke();

		// Satellite
		const dotR = R * (0.018 + v * 0.045);
		ctx.fillStyle = i % 2 === 0 ? accent : UMI_PALETTE.cream;
		ctx.shadowColor = i % 2 === 0 ? accent : UMI_PALETTE.cream;
		ctx.shadowBlur = 12 * v;
		ctx.beginPath();
		ctx.arc(px, py, dotR, 0, Math.PI * 2);
		ctx.fill();
		ctx.shadowBlur = 0;

		// Inner ring
		ctx.strokeStyle = "rgba(20,9,10,0.6)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(px, py, dotR, 0, Math.PI * 2);
		ctx.stroke();
	}

	// 3. Beat halo — bright orange arc that flares outward on each beat.
	if (beatPulse > 0.05) {
		ctx.strokeStyle = `rgba(255,103,0,${beatPulse * 0.6})`;
		ctx.lineWidth = 3 + beatPulse * 6;
		ctx.beginPath();
		ctx.arc(0, 0, R * (0.55 + (1 - beatPulse) * 0.20), -Math.PI / 8, Math.PI / 8);
		ctx.stroke();
	}

	// 4. Faint petal lines — geometric scaffolding so the wedge
	//    feels intentional rather than random scatter.
	ctx.strokeStyle = "rgba(251,241,199,0.08)";
	ctx.lineWidth = 1;
	for (let k = 1; k <= 4; k++) {
		ctx.beginPath();
		ctx.arc(0, 0, R * (k / 5), -Math.PI / 4, Math.PI / 4);
		ctx.stroke();
	}
}
