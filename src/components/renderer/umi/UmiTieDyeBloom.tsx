// UmiTieDyeBloom — every beat spawns a translucent radial bloom at a
// random point on the canvas; blooms expand and fade over ~5 seconds,
// composited additively so overlaps brighten into watercolor pools.
// Color cycles through the UMI palette so the surface stays in brand.

import React, { useCallback, useContext, useMemo } from "react";
import AnimatedCanvas from "../../AnimatedCanvas";
import { ErrorHandlerContext, ErrorRecovery } from "../../../error";
import { RendererProps } from "../../../app";
import { binarySearchIndex } from "../../../utils";
import { UMI_PALETTE, getForceUmiPalette, effectiveAccent } from "./umiPalette";
import { drawScanlines, drawVignette } from "./drawHelpers";

const BLOOM_LIFETIME_MS = 5200;
const MAX_BLOOMS = 36;

type Bloom = {
	x: number;
	y: number;
	maxR: number;
	bornAt: number;
	color: string;
};

type CanvasData = {
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
			blooms: Bloom[];
			paletteCycle: number;
	  };

function pickBloomColor(state: { paletteCycle: number }, accent: string): string {
	// Cycle through orange family + cream + redline; preserve brand bias.
	const palette = [
		accent,
		UMI_PALETTE.bright,
		accent,
		UMI_PALETTE.deep,
		accent,
		UMI_PALETTE.cream,
		UMI_PALETTE.redline,
		accent
	];
	state.paletteCycle = (state.paletteCycle + 1) % palette.length;
	return palette[state.paletteCycle];
}

export default function UmiTieDyeBloom(props: RendererProps) {
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
		return {
			isError: false,
			lastBeatIdx: -1,
			lastSectionIdx: -1,
			blooms: [],
			paletteCycle: 0
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

			// Solid base — repaint each frame, blooms layer on top with
			// `lighter` composite for additive watercolor blending.
			const bg = ctx.createRadialGradient(
				width / 2,
				height / 2,
				Math.min(width, height) * 0.05,
				width / 2,
				height / 2,
				Math.max(width, height) * 0.7
			);
			bg.addColorStop(0, UMI_PALETTE.warmDark);
			bg.addColorStop(1, UMI_PALETTE.warmDarkDeep);
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, width, height);

			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(data.themeColor);
			const progress = Spicetify.Player.getProgress() / 1000;
			const now = performance.now();

			// Spawn a bloom on every beat
			const beatIdx = binarySearchIndex(data.beats, b => b, progress);
			if (beatIdx !== state.lastBeatIdx && beatIdx >= 0) {
				state.lastBeatIdx = beatIdx;
				const margin = Math.min(width, height) * 0.10;
				state.blooms.push({
					x: margin + Math.random() * (width - margin * 2),
					y: margin + Math.random() * (height - margin * 2),
					maxR: Math.min(width, height) * (0.18 + Math.random() * 0.22),
					bornAt: now,
					color: pickBloomColor(state, accent)
				});
				if (state.blooms.length > MAX_BLOOMS) state.blooms.shift();
			}

			// Section change — spawn an extra-large bloom in the middle
			const sectionIdx = binarySearchIndex(data.sections, s => s, progress);
			if (sectionIdx !== state.lastSectionIdx && sectionIdx >= 0) {
				state.lastSectionIdx = sectionIdx;
				state.blooms.push({
					x: width / 2,
					y: height / 2,
					maxR: Math.min(width, height) * 0.55,
					bornAt: now,
					color: pickBloomColor(state, accent)
				});
				if (state.blooms.length > MAX_BLOOMS) state.blooms.shift();
			}

			// Render each live bloom additively
			ctx.save();
			ctx.globalCompositeOperation = "lighter";
			for (let i = state.blooms.length - 1; i >= 0; i--) {
				const b = state.blooms[i];
				const age = (now - b.bornAt) / BLOOM_LIFETIME_MS;
				if (age >= 1) {
					state.blooms.splice(i, 1);
					continue;
				}
				// Easing: fast burst, slow fade
				const radius = b.maxR * Math.pow(age, 0.45);
				const alpha = (1 - age) * 0.35;

				const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, radius);
				const rgb = hexToRgbCss(b.color);
				grad.addColorStop(0, `rgba(${rgb},${alpha * 0.95})`);
				grad.addColorStop(0.4, `rgba(${rgb},${alpha * 0.55})`);
				grad.addColorStop(0.85, `rgba(${rgb},${alpha * 0.10})`);
				grad.addColorStop(1, `rgba(${rgb},0)`);
				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.restore();

			// Subtle warm grain so the dark base doesn't look flat
			drawScanlines(ctx, width, height, 0.05, 3);
			drawVignette(ctx, width, height, 0.45);

			// Slow drift on every bloom (very small) — prevents the
			// surface looking static on long-held beats.
			void time;
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

// Tiny helper — turns "#ff6700" into "255,103,0" for rgba() strings.
function hexToRgbCss(hex: string): string {
	const h = hex.replace(/^#/, "");
	const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
	const r = parseInt(full.slice(0, 2), 16);
	const g = parseInt(full.slice(2, 4), 16);
	const b = parseInt(full.slice(4, 6), 16);
	return `${r},${g},${b}`;
}
