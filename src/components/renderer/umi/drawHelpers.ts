// Canvas2D helpers shared by the umi-* renderers.
// Pure functions over a CanvasRenderingContext2D; no React, no state.

export function roundedRectPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
): void {
	const radius = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	if (typeof (ctx as any).roundRect === "function") {
		(ctx as any).roundRect(x, y, w, h, radius);
		return;
	}
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

/**
 * Diagonal hazard-tape stripes within (x,y,w,h). Two-tone, alternating.
 * Default tone = orange/black per UMI brand.
 */
export function drawHazardStripe(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	color1: string,
	color2: string,
	stripeWidth = 12
): void {
	if (w <= 0 || h <= 0) return;
	ctx.save();
	ctx.beginPath();
	ctx.rect(x, y, w, h);
	ctx.clip();

	const total = w + h * 2;
	let stripeIdx = 0;
	for (let p = -h; p < total; p += stripeWidth) {
		ctx.fillStyle = stripeIdx % 2 === 0 ? color1 : color2;
		ctx.beginPath();
		ctx.moveTo(x + p, y);
		ctx.lineTo(x + p + stripeWidth, y);
		ctx.lineTo(x + p + stripeWidth + h, y + h);
		ctx.lineTo(x + p + h, y + h);
		ctx.closePath();
		ctx.fill();
		stripeIdx++;
	}
	ctx.restore();
}

/**
 * Rounded rectangle with a cream-bevel inner highlight at top
 * and a black inner shadow at bottom — the glassy '00s panel look.
 */
export function drawBevel(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	radius: number,
	fillColor: string,
	highlightColor = "rgba(255,255,255,0.18)",
	shadowColor = "rgba(0,0,0,0.45)"
): void {
	ctx.save();
	roundedRectPath(ctx, x, y, w, h, radius);
	ctx.fillStyle = fillColor;
	ctx.fill();

	ctx.lineWidth = 1;
	const inset = radius / 4;

	// Top inner highlight
	ctx.beginPath();
	ctx.moveTo(x + radius, y + 1);
	ctx.lineTo(x + w - radius, y + 1);
	ctx.strokeStyle = highlightColor;
	ctx.stroke();

	// Bottom inner shadow
	ctx.beginPath();
	ctx.moveTo(x + radius, y + h - 1);
	ctx.lineTo(x + w - radius, y + h - 1);
	ctx.strokeStyle = shadowColor;
	ctx.stroke();

	// Outer ring (depth)
	roundedRectPath(ctx, x, y, w, h, radius);
	ctx.strokeStyle = "rgba(0,0,0,0.7)";
	ctx.stroke();

	ctx.restore();
	void inset;
}

/**
 * Analog gauge needle from centre (cx,cy), length r, at angle `angle`
 * radians (0 = right, increases counter-clockwise as standard math).
 * Includes a small dark hub at the pivot.
 */
export function drawGaugeNeedle(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	r: number,
	angle: number,
	needleColor: string,
	hubColor = "#3c3836"
): void {
	ctx.save();
	ctx.translate(cx, cy);
	ctx.rotate(angle);

	ctx.lineCap = "round";
	ctx.lineWidth = Math.max(2, r * 0.04);

	// Counter-tail (cream stub on the opposite side of the pivot)
	ctx.strokeStyle = "rgba(251,241,199,0.55)";
	ctx.beginPath();
	ctx.moveTo(0, 0);
	ctx.lineTo(-r * 0.18, 0);
	ctx.stroke();

	// Main needle
	ctx.strokeStyle = needleColor;
	ctx.beginPath();
	ctx.moveTo(0, 0);
	ctx.lineTo(r * 0.95, 0);
	ctx.stroke();

	// Pivot hub
	ctx.fillStyle = hubColor;
	ctx.beginPath();
	ctx.arc(0, 0, r * 0.085, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = "rgba(0,0,0,0.6)";
	ctx.stroke();

	ctx.restore();
}

/**
 * Tick-mark arc on a gauge face, from `startAngle` to `endAngle`.
 * Major ticks every `majorEvery`-th step; minor ticks otherwise.
 */
export function drawGaugeTicks(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	r: number,
	startAngle: number,
	endAngle: number,
	steps: number,
	majorEvery: number,
	color: string
): void {
	ctx.save();
	ctx.strokeStyle = color;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const angle = startAngle + (endAngle - startAngle) * t;
		const isMajor = i % majorEvery === 0;
		const inner = r * (isMajor ? 0.84 : 0.9);
		const outer = r * 0.97;
		ctx.lineWidth = isMajor ? 2 : 1;
		ctx.beginPath();
		ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
		ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
		ctx.stroke();
	}
	ctx.restore();
}

/**
 * Redline arc — orange wedge overlaid near the high end of the gauge.
 * Drawn just outside the tick band.
 */
export function drawRedlineArc(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	r: number,
	startAngle: number,
	endAngle: number,
	color: string
): void {
	ctx.save();
	ctx.strokeStyle = color;
	ctx.lineWidth = Math.max(3, r * 0.05);
	ctx.lineCap = "butt";
	ctx.beginPath();
	ctx.arc(cx, cy, r * 0.92, startAngle, endAngle);
	ctx.stroke();
	ctx.restore();
}

/**
 * 1-pixel horizontal scanlines across the entire canvas, very subtle.
 * Used for the CRT-feel renderers (oscilloscope, phosphor bars).
 */
export function drawScanlines(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	alpha = 0.12,
	spacing = 2
): void {
	ctx.save();
	ctx.fillStyle = `rgba(0,0,0,${alpha})`;
	for (let y = 0; y < height; y += spacing) {
		ctx.fillRect(0, y, width, 1);
	}
	ctx.restore();
}

/**
 * Reticle grid — cells × cells lines across the frame, faint cream.
 * Heavier centre cross (matches a CRT scope reticle).
 */
export function drawReticle(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	cells: number,
	color = "rgba(251,241,199,0.18)"
): void {
	ctx.save();
	ctx.strokeStyle = color;
	ctx.lineWidth = 1;

	for (let i = 1; i < cells; i++) {
		const px = x + (w * i) / cells;
		const py = y + (h * i) / cells;
		ctx.beginPath();
		ctx.moveTo(px, y);
		ctx.lineTo(px, y + h);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(x, py);
		ctx.lineTo(x + w, py);
		ctx.stroke();
	}

	// Heavier centre cross
	ctx.strokeStyle = color.replace(/[\d.]+\)$/, "0.35)");
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(x + w / 2, y);
	ctx.lineTo(x + w / 2, y + h);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x, y + h / 2);
	ctx.lineTo(x + w, y + h / 2);
	ctx.stroke();

	ctx.restore();
}

/**
 * Vignette around the edges — adds depth, makes the centre pop.
 * Used by the oscilloscope and gauge cluster.
 */
export function drawVignette(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	strength = 0.55
): void {
	ctx.save();
	const grad = ctx.createRadialGradient(
		width / 2,
		height / 2,
		Math.min(width, height) * 0.3,
		width / 2,
		height / 2,
		Math.max(width, height) * 0.7
	);
	grad.addColorStop(0, "rgba(0,0,0,0)");
	grad.addColorStop(1, `rgba(0,0,0,${strength})`);
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}
