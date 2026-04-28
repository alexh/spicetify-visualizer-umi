// UMI palette — single source of truth for the umi-* renderers.
// Mirrors the colors.toml values from omarchy-umi-theme so the
// visualizer stays in lockstep with the rest of the desktop.

export const UMI_ORANGE = "#FF6700";
export const UMI_ORANGE_BRIGHT = "#FF7a1a";
export const UMI_ORANGE_DEEP = "#cc4a00";
export const UMI_CREAM = "#fbf1c7";
export const UMI_WARM_DARK = "#2a1c12";
export const UMI_WARM_DARK_DEEP = "#1f1410";
export const UMI_WARM_GREY = "#3c3836";
export const UMI_HAZARD_BLACK = "#0a0605";
export const UMI_REDLINE = "#fb4934";

export type UmiPalette = {
	orange: string;
	bright: string;
	deep: string;
	cream: string;
	warmDark: string;
	warmDarkDeep: string;
	warmGrey: string;
	hazardBlack: string;
	redline: string;
};

export const UMI_PALETTE: UmiPalette = {
	orange: UMI_ORANGE,
	bright: UMI_ORANGE_BRIGHT,
	deep: UMI_ORANGE_DEEP,
	cream: UMI_CREAM,
	warmDark: UMI_WARM_DARK,
	warmDarkDeep: UMI_WARM_DARK_DEEP,
	warmGrey: UMI_WARM_GREY,
	hazardBlack: UMI_HAZARD_BLACK,
	redline: UMI_REDLINE
};

// "Force UMI palette" toggle — when true (default), umi-* renderers
// ignore the album-art-derived themeColor and use the brand palette.
// Persisted in localStorage so the toggle survives reloads.
const TOGGLE_KEY = "umi-visualizer:force-palette";
const TOGGLE_EVENT = "umi-palette-changed";

export function getForceUmiPalette(): boolean {
	const stored = typeof localStorage !== "undefined" ? localStorage.getItem(TOGGLE_KEY) : null;
	return stored !== "false"; // default ON
}

export function setForceUmiPalette(value: boolean): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(TOGGLE_KEY, value ? "true" : "false");
	window.dispatchEvent(new Event(TOGGLE_EVENT));
}

export function subscribeForceUmiPalette(callback: () => void): () => void {
	window.addEventListener(TOGGLE_EVENT, callback);
	return () => window.removeEventListener(TOGGLE_EVENT, callback);
}

// Helper: returns the renderer's effective accent color. If the
// "force UMI palette" toggle is on, returns UMI orange; otherwise
// returns the album-art-derived themeColor.
export function effectiveAccent(themeColor: Spicetify.Color): string {
	if (getForceUmiPalette()) return UMI_ORANGE;
	return themeColor.toCSS(Spicetify.Color.CSSFormat.HEX);
}
