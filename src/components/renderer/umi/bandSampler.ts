// Wrapper around RhythmString — gives renderers a single
// `sampleBands(rhythm, t)` call that returns one normalised
// amplitude per frequency channel for time `t`. Lifted from
// SpectrumVisualizer's inline gaussian-window sampling so the
// umi-* renderers can share it.

import { binarySearchIndex } from "../../../utils";
import { parseRhythmString, RhythmString } from "../../../RhythmString";

export type { RhythmString };

const RHYTHM_WEIGHT = 0.4;
const RHYTHM_OFFSET = 0.2;

export function precomputeRhythm(rhythmString: string): RhythmString {
	return parseRhythmString(rhythmString);
}

/**
 * Per-frame band amplitude sampler.
 * Returns one value in roughly [0, 1] per rhythm channel — values are
 * peak-normalised across channels at this `t`, so at any moment the
 * loudest band is 1.0. Pass an offset of 0..1 to apply a tiny smoothing
 * window without recomputing the whole curve.
 */
export function sampleBands(rhythm: RhythmString, t: number): number[] {
	if (rhythm.length === 0) return [];

	const windowSize = (RHYTHM_WEIGHT / Math.sqrt(2)) * 8;
	const start = t - windowSize;
	const end = t + windowSize;

	const result: number[] = new Array(rhythm.length);
	let max = 0;

	for (let i = 0; i < rhythm.length; i++) {
		const channel = rhythm[i];
		const sIdx = binarySearchIndex(channel, e => e, start);
		const eIdx = binarySearchIndex(channel, e => e, end);

		let acc = 0;
		for (let j = sIdx; j <= eIdx && j < channel.length; j++) {
			const dt = (channel[j] - t) / RHYTHM_WEIGHT;
			acc += Math.exp(-dt * dt);
		}
		const value = acc + RHYTHM_OFFSET;
		if (value > max) max = value;
		result[i] = value;
	}

	if (max > 0) for (let i = 0; i < result.length; i++) result[i] /= max;
	return result;
}

/**
 * Resamples a rhythm-band array to a fixed `bandCount`:
 *  - if input has more channels than requested, averages neighbours
 *    (downsample)
 *  - if input has fewer, linearly interpolates between adjacent
 *    channels (upsample) so we don't get gaps at every Nth column.
 * Useful when a renderer wants e.g. exactly 24 columns regardless
 * of how many channels Spotify shipped.
 */
export function downsampleBands(bands: number[], bandCount: number): number[] {
	if (bands.length === 0) return new Array(bandCount).fill(0);
	if (bands.length === bandCount) return bands;

	// Upsample (input shorter than requested) — linear interpolation
	if (bands.length < bandCount) {
		const out: number[] = new Array(bandCount);
		for (let i = 0; i < bandCount; i++) {
			const pos = bandCount === 1 ? 0 : (i / (bandCount - 1)) * (bands.length - 1);
			const lo = Math.floor(pos);
			const hi = Math.min(bands.length - 1, lo + 1);
			const frac = pos - lo;
			out[i] = bands[lo] * (1 - frac) + bands[hi] * frac;
		}
		return out;
	}

	// Downsample (input longer than requested) — average groups
	const out: number[] = new Array(bandCount).fill(0);
	const counts: number[] = new Array(bandCount).fill(0);
	for (let i = 0; i < bands.length; i++) {
		const target = Math.min(bandCount - 1, Math.floor((i / bands.length) * bandCount));
		out[target] += bands[i];
		counts[target]++;
	}
	for (let i = 0; i < bandCount; i++) {
		if (counts[i] > 0) out[i] /= counts[i];
	}
	return out;
}
