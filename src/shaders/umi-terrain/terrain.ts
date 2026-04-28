// UMI / Terrain (3D) — raw WebGL2 raymarched terrain shader.
// Renders a fullscreen quad; the fragment shader casts a ray per
// pixel from a virtual camera, marches along it sampling a noise
// heightfield modulated by audio uniforms, then shades by height
// with a UMI palette ramp + warm-dark fog.

export const vertexShader = `#version 300 es

in vec2 inPosition;
out vec2 fragUV;

void main() {
    gl_Position = vec4(inPosition, 0.0, 1.0);
    fragUV = inPosition;
}
`;

export const fragmentShader = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uBeatPulse;
uniform vec2  uResolution;
uniform vec3  uAccent;
uniform vec3  uCream;
uniform vec3  uDark;

in  vec2 fragUV;
out vec4 outColor;

// --- value-noise -------------------------------------------------
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i + vec2(0.0, 0.0));
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.55;
    for (int i = 0; i < 5; i++) {
        v += noise(p) * amp;
        p *= 2.05;
        amp *= 0.5;
    }
    return v;
}

// --- height field --------------------------------------------------
float heightAt(vec2 xz) {
    float drift = uTime * 0.07;
    float h = 0.0;
    h += fbm(xz * 0.18 + vec2(drift, drift * 0.3)) * 4.0 - 1.5;

    // Bass: radial sin ripple from origin
    float dist = length(xz);
    h += sin(dist * 0.55 - uTime * 2.4) * uBass * 1.6;

    // Mid: broad slow swell
    h += fbm(xz * 0.07 - vec2(drift)) * uMid * 2.6;

    // High: fine shimmer
    h += (noise(xz * 1.4 + uTime * 0.5) - 0.5) * uHigh * 0.9;

    // Beat: gaussian impulse at centre
    h += uBeatPulse * exp(-dist * dist * 0.025) * 3.0;

    return h;
}

// --- raymarcher ---------------------------------------------------
// Returns the world-space hit point. If miss: t < 0.
float raymarch(vec3 ro, vec3 rd, out vec3 hitPos) {
    float t = 0.5;
    float lh = 0.0; // last height
    float ly = 0.0; // last y
    for (int i = 0; i < 200; i++) {
        vec3 p = ro + rd * t;
        float h = heightAt(p.xz);
        if (p.y < h) {
            // crossed under the heightfield — interpolate the crossing
            t = t - (lh - ly) * (t - (t - 0.6)) / ((p.y - ly) - (h - lh));
            hitPos = ro + rd * t;
            return t;
        }
        lh = h;
        ly = p.y;
        // step proportional to current height clearance, capped
        float dy = max(0.4, p.y - h);
        t += dy * 0.4;
        if (t > 90.0) break;
    }
    hitPos = vec3(0.0);
    return -1.0;
}

// --- shading ------------------------------------------------------
vec3 shade(vec3 p, vec3 rd) {
    // Surface normal via height-field gradient
    float eps = 0.4;
    float hC = heightAt(p.xz);
    float hX = heightAt(p.xz + vec2(eps, 0.0));
    float hZ = heightAt(p.xz + vec2(0.0, eps));
    vec3 normal = normalize(vec3(hC - hX, eps, hC - hZ));

    // Height-based ramp: dark valleys → orange ridges → cream caps
    float t = clamp((hC + 2.5) / 8.0, 0.0, 1.0);
    vec3 col = mix(uDark, uAccent, smoothstep(0.05, 0.6, t));
    col = mix(col, uCream, smoothstep(0.78, 1.0, t));

    // Cheap directional light + rim
    vec3 lightDir = normalize(vec3(0.4, 0.8, 0.3));
    float diff = max(0.0, dot(normal, lightDir));
    col *= 0.55 + 0.65 * diff;

    // Beat boost — uniform brighten on each kick
    col = mix(col, uCream, uBeatPulse * 0.20);

    // Wireframe-ish accent: emphasise grid lines via screen-space noise
    float grid = max(0.0, 0.5 - abs(fract(p.x * 0.5) - 0.5));
    grid = max(grid, 0.5 - abs(fract(p.z * 0.5) - 0.5));
    col += uAccent * grid * 0.18;

    return col;
}

void main() {
    vec2 uv = fragUV;
    uv.x *= uResolution.x / uResolution.y;

    // --- camera (slow orbit + bob) ---
    float orbitSpeed = 0.07;
    float orbitR = 22.0;
    vec3 ro = vec3(
        sin(uTime * orbitSpeed) * orbitR,
        9.0 + sin(uTime * 0.13) * 2.0,
        cos(uTime * orbitSpeed) * orbitR
    );
    vec3 ta = vec3(0.0, 1.0, 0.0);

    // build view basis
    vec3 fwd = normalize(ta - ro);
    vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, fwd);

    // Perspective ray
    float fov = 1.20;
    vec3 rd = normalize(uv.x * right + uv.y * up + fwd / fov);

    vec3 hitPos;
    float tHit = raymarch(ro, rd, hitPos);

    vec3 col;
    if (tHit < 0.0) {
        // sky — radial gradient warm-dark to a hint of orange near the horizon
        float horizon = 1.0 - clamp(rd.y * 1.5, 0.0, 1.0);
        col = mix(uDark, mix(uDark, uAccent, 0.18), horizon);
    } else {
        col = shade(hitPos, rd);
        // Fog into warm-dark by ray distance
        float fog = clamp((tHit - 6.0) / 36.0, 0.0, 1.0);
        col = mix(col, uDark, fog * 0.95);
    }

    // Vignette
    float vig = smoothstep(1.45, 0.6, length(fragUV));
    col *= 0.55 + 0.45 * vig;

    // Subtle scanlines (driven by absolute pixel y, not uv)
    float scan = 0.05 * sin(gl_FragCoord.y * 3.14159);
    col -= scan;

    outColor = vec4(col, 1.0);
}
`;
