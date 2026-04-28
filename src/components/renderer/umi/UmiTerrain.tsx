// UmiTerrain — three.js wireframe terrain that ripples with audio.
// Multi-octave Perlin-noise base shape; bass drives a centre swell,
// mids drive a slow wave, highs add a fine shimmer, beats kick a
// radial impulse from the centre. Camera slowly orbits. Color ramps
// dark → orange → cream by vertex height; warm-dark fog at distance.
//
// Bypasses AnimatedCanvas (three.js manages its own canvas + GL ctx).

import React, { useEffect, useMemo, useRef } from "react";
import {
	BufferAttribute,
	Color,
	Fog,
	Mesh,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	ShaderMaterial,
	WebGLRenderer
} from "three";
import { binarySearchIndex } from "../../../utils";
import { RendererProps } from "../../../app";
import {
	UMI_PALETTE,
	getForceUmiPalette,
	effectiveAccent,
	subscribeForceUmiPalette
} from "./umiPalette";
import {
	precomputeRhythm,
	sampleBands,
	downsampleBands,
	type RhythmString
} from "./bandSampler";

const TERRAIN_SUBDIVISIONS = 96;
const TERRAIN_SIZE = 60;

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uBeatPulse;
  varying float vHeight;
  varying vec3 vWorldPos;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0, 0.0)),
                   hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)),
                   hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    vec3 pos = position;

    // Multi-octave terrain base — slowly drifts on its own
    float h = 0.0;
    h += noise(pos.xz * 0.08  + uTime * 0.05) * 2.2;
    h += noise(pos.xz * 0.20  - uTime * 0.07) * 1.0;
    h += noise(pos.xz * 0.55  + uTime * 0.10) * 0.45;

    float dist = length(pos.xz);

    // Bass: ripple radiating from centre
    float bassRipple = sin(dist * 0.32 - uTime * 2.4) * uBass * 1.6;
    // Mid: broad slow swell
    float midSwell = noise(pos.xz * 0.06 + uTime * 0.10) * uMid * 2.2;
    // High: fine shimmering noise
    float highShimmer = (noise(pos.xz * 1.6 + uTime * 0.55) - 0.5) * uHigh * 0.7;
    // Beat: gaussian bump at centre
    float beatBump = uBeatPulse * exp(-dist * dist * 0.012) * 3.5;

    pos.y += h + bassRipple + midSwell + highShimmer + beatBump;

    vHeight = pos.y;
    vWorldPos = pos;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec3 uAccent;
  uniform vec3 uCream;
  uniform vec3 uDark;
  uniform float uBeatPulse;
  varying float vHeight;
  varying vec3 vWorldPos;

  void main() {
    // Height ramp — dark valleys → orange ridges → cream caps
    float t = clamp((vHeight + 2.5) / 8.0, 0.0, 1.0);
    vec3 color = mix(uDark, uAccent, smoothstep(0.05, 0.6, t));
    color = mix(color, uCream, smoothstep(0.78, 1.0, t));

    // Beat pulse boosts brightness uniformly so the wireframe
    // 'flashes' on each kick
    color = mix(color, uCream, uBeatPulse * 0.18);

    // Radial fog into warm-dark
    float dist = length(vWorldPos.xz);
    float fog = clamp((dist - 12.0) / 22.0, 0.0, 1.0);
    color = mix(color, uDark, fog * 0.95);

    gl_FragColor = vec4(color, 1.0);
  }
`;

type RhythmData = {
	rhythm: RhythmString;
	beats: number[];
};

export default function UmiTerrain(props: RendererProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	const rhythmData = useMemo<RhythmData>(() => {
		if (!props.audioAnalysis) return { rhythm: [] as RhythmString, beats: [] };
		if (props.audioAnalysis.track.rhythm_version !== 1) {
			return { rhythm: [] as RhythmString, beats: [] };
		}
		return {
			rhythm: precomputeRhythm(props.audioAnalysis.track.rhythmstring),
			beats: props.audioAnalysis.beats.map(b => b.start)
		};
	}, [props.audioAnalysis]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const win = container.ownerDocument.defaultView;
		if (!win) return;

		// Sizing
		let width = container.clientWidth || 1;
		let height = container.clientHeight || 1;
		const dpr = Math.min(2, win.devicePixelRatio || 1);

		// Three core
		const scene = new Scene();
		scene.background = new Color(UMI_PALETTE.warmDarkDeep);
		scene.fog = new Fog(UMI_PALETTE.warmDarkDeep, 24, 70);

		const camera = new PerspectiveCamera(58, width / height, 0.1, 200);
		camera.position.set(0, 9, 20);
		camera.lookAt(0, 0, 0);

		const renderer = new WebGLRenderer({ antialias: true, alpha: false });
		renderer.setSize(width, height);
		renderer.setPixelRatio(dpr);
		renderer.domElement.style.display = "block";
		renderer.domElement.style.width = "100%";
		renderer.domElement.style.height = "100%";
		container.appendChild(renderer.domElement);

		// Terrain mesh
		const geometry = new PlaneGeometry(
			TERRAIN_SIZE,
			TERRAIN_SIZE,
			TERRAIN_SUBDIVISIONS,
			TERRAIN_SUBDIVISIONS
		);
		geometry.rotateX(-Math.PI / 2);
		// Mark UVs as static; not used in shader but kept for completeness
		void (geometry.attributes.uv as BufferAttribute);

		const initialAccent = new Color(
			getForceUmiPalette() ? UMI_PALETTE.orange : effectiveAccent(props.themeColor)
		);

		const uniforms = {
			uTime: { value: 0 },
			uBass: { value: 0 },
			uMid: { value: 0 },
			uHigh: { value: 0 },
			uBeatPulse: { value: 0 },
			uAccent: { value: initialAccent },
			uCream: { value: new Color(UMI_PALETTE.cream) },
			uDark: { value: new Color(UMI_PALETTE.warmDarkDeep) }
		};

		const material = new ShaderMaterial({
			vertexShader: VERTEX_SHADER,
			fragmentShader: FRAGMENT_SHADER,
			uniforms,
			wireframe: true
		});

		const terrain = new Mesh(geometry, material);
		scene.add(terrain);

		// React to "Force UMI palette" toggle changes
		const unsubPalette = subscribeForceUmiPalette(() => {
			const accent = getForceUmiPalette()
				? UMI_PALETTE.orange
				: effectiveAccent(props.themeColor);
			uniforms.uAccent.value.set(accent);
		});

		// Resize observer keeps things crisp on window resize / fullscreen
		const ro = new win.ResizeObserver(() => {
			width = container.clientWidth || 1;
			height = container.clientHeight || 1;
			renderer.setSize(width, height);
			camera.aspect = width / height;
			camera.updateProjectionMatrix();
		});
		ro.observe(container);

		// Render loop
		let frameId = 0;
		const start = performance.now();

		const animate = () => {
			const elapsed = (performance.now() - start) / 1000;
			uniforms.uTime.value = elapsed;

			// Bands → low / mid / high
			const progress = Spicetify.Player.getProgress() / 1000;
			if (rhythmData.rhythm.length > 0) {
				const raw = sampleBands(rhythmData.rhythm, progress);
				const three = downsampleBands(raw, 3);
				uniforms.uBass.value = three[0] ?? 0;
				uniforms.uMid.value = three[1] ?? 0;
				uniforms.uHigh.value = three[2] ?? 0;
			} else {
				uniforms.uBass.value = 0;
				uniforms.uMid.value = 0;
				uniforms.uHigh.value = 0;
			}

			// Beat pulse — exponentially decays, peaks at each beat onset
			if (rhythmData.beats.length > 0) {
				const idx = binarySearchIndex(rhythmData.beats, b => b, progress);
				const beatStart = idx >= 0 && idx < rhythmData.beats.length ? rhythmData.beats[idx] : 0;
				const phase = Math.max(0, progress - beatStart);
				uniforms.uBeatPulse.value = Math.exp(-phase * 5);
			} else {
				uniforms.uBeatPulse.value = 0;
			}

			// Camera slow orbit + gentle bob
			const orbitR = 22;
			const orbitSpeed = 0.07;
			camera.position.x = Math.sin(elapsed * orbitSpeed) * orbitR;
			camera.position.z = Math.cos(elapsed * orbitSpeed) * orbitR;
			camera.position.y = 9 + Math.sin(elapsed * 0.13) * 2.2;
			camera.lookAt(0, 1, 0);

			renderer.render(scene, camera);
			frameId = win.requestAnimationFrame(animate);
		};

		if (props.isEnabled) {
			frameId = win.requestAnimationFrame(animate);
		}

		return () => {
			if (frameId) win.cancelAnimationFrame(frameId);
			unsubPalette();
			ro.disconnect();
			geometry.dispose();
			material.dispose();
			renderer.dispose();
			if (renderer.domElement.parentNode === container) {
				container.removeChild(renderer.domElement);
			}
		};
	}, [rhythmData, props.isEnabled, props.themeColor]);

	return (
		<div
			ref={containerRef}
			style={{
				width: "100%",
				height: "100%",
				background: UMI_PALETTE.warmDarkDeep
			}}
		/>
	);
}
