import { requestUrl } from "obsidian";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/** Векторная карта OpenFreeMap (данные OpenStreetMap, без ключа API) */
export const VECTOR_THEMES: Record<string, string> = {
	positron: "Минимализм — только улицы и города, мало подписей",
	liberty: "Подробная — заведения, остановки, здания",
	bright: "Яркая — насыщенные цвета, контрастные дороги и парки",
};

export const LABEL_LANGS: Record<string, string> = {
	ru: "Русские",
	en: "Английские",
};

export type ColorScheme = "light" | "dark" | "jojo";

export const COLOR_SCHEMES: Record<ColorScheme, string> = {
	light: "Светлая",
	dark: "Темная",
	jojo: "JoJo's Bizarre Adventure",
};

export interface VectorOptions {
	scheme: ColorScheme;
	buildings3d: boolean;
}

/** id слоя 3D-зданий, который добавляет плагин */
const BUILDINGS_3D_LAYER = "map-notes-buildings-3d";

const rawCache = new Map<string, Promise<StyleSpecification>>();

function fetchStyle(id: string): Promise<StyleSpecification> {
	let p = rawCache.get(id);
	if (!p) {
		p = requestUrl({ url: `https://tiles.openfreemap.org/styles/${id}` })
			.then((r) => r.json as StyleSpecification);
		p.catch(() => rawCache.delete(id));
		rawCache.set(id, p);
	}
	return p;
}

/** Подпись на выбранном языке; если перевода нет — английская, затем местная */
function labelExpression(lang: string): unknown {
	const chain = lang === "ru"
		? ["name:ru", "name:en", "name_en", "name:latin", "name"]
		: ["name:en", "name_en", "name:latin", "name"];
	return ["coalesce", ...chain.map((k) => ["get", k])];
}

export async function loadVectorStyle(themeId: string, lang: string, opts: VectorOptions): Promise<StyleSpecification> {
	const theme = VECTOR_THEMES[themeId] ? themeId : "liberty";
	const raw = await fetchStyle(theme);
	const style = JSON.parse(JSON.stringify(raw)) as StyleSpecification;

	const label = labelExpression(lang);
	for (const layer of style.layers) {
		if (layer.type !== "symbol") continue;
		const tf = layer.layout?.["text-field"];
		// меняем только названия; номера дорог и домов (ref, housenumber) не трогаем
		if (tf && JSON.stringify(tf).includes("name")) {
			(layer.layout as Record<string, unknown>)["text-field"] = label;
		}
	}

	if (opts.scheme === "dark") applyDark(style);
	else if (opts.scheme === "jojo") applyJojo(style);
	styleFlatBuildings(style, opts.scheme);
	applyBuildings(style, opts, roofColor(style, opts.scheme));
	return style;
}

// ---------------- здания ----------------

/**
 * Цвет зданий считается от цвета фона темы в перцептивном пространстве OKLab:
 * меняем только светлоту на небольшой шаг (оттенок и насыщенность сохраняются),
 * поэтому дома одинаково заметны во всех темах и схемах, но не «выпрыгивают».
 * Шаги — разница светлоты L в OKLab (0…1) на крупном масштабе.
 */
const BUILDING_STEPS: Record<ColorScheme, { fill: number; outline: number; roof3d: number; chroma: number }> = {
	// светлая: дома чуть темнее земли, кромка ещё немного темнее
	light: { fill: -0.055, outline: -0.1, roof3d: -0.035, chroma: 1 },
	// тёмная: дома чуть темнее графитовой земли; крыши в 3D — чуть светлее, чтобы объём читался
	dark: { fill: -0.04, outline: -0.075, roof3d: 0.035, chroma: 1 },
	// JoJo: светлые лавандовые дома на фиолетовой земле
	jojo: { fill: 0.09, outline: -0.04, roof3d: 0.12, chroma: 1.15 },
};

/** На мелких масштабах дома почти сливаются с фоном и проявляются при приближении */
const ZOOM_RAMP: [number, number][] = [[13, 0.35], [15, 0.75], [17, 1]];

function lastColor(v: unknown): string | null {
	if (typeof v === "string") return parseColor(v) ? v : null;
	if (Array.isArray(v)) {
		for (let i = v.length - 1; i >= 0; i--) {
			const c = lastColor(v[i]);
			if (c) return c;
		}
	}
	return null;
}

function backgroundColor(style: StyleSpecification): string {
	const bg = style.layers.find((l) => l.type === "background");
	const c = bg?.paint && lastColor((bg.paint as Record<string, unknown>)["background-color"]);
	return c ?? "#f2efe9";
}

/** «Земля», на которой стоят дома: в JoJo жилые кварталы закрашены отдельным цветом поверх фона */
function groundColor(style: StyleSpecification, scheme: ColorScheme): string {
	return scheme === "jojo" ? JOJO.land : backgroundColor(style);
}

/** Цвет со смещённой светлотой: на крупном масштабе step, на мелких — меньше */
function rampedShift(base: string, step: number, chroma: number): unknown {
	return ["interpolate", ["linear"], ["zoom"],
		...ZOOM_RAMP.flatMap(([z, k]) => [z, shiftLightness(base, step * k, 1 + (chroma - 1) * k)])];
}

/**
 * Плоские здания: перекрашиваем существующий слой или добавляем свой,
 * если в теме его нет, — чтобы дома всегда были видны и не сливались с фоном.
 */
function styleFlatBuildings(style: StyleSpecification, scheme: ColorScheme) {
	const layers = style.layers.filter((l) => l.type === "fill" && l["source-layer"] === "building");
	// в «Подробной» плоские дома ограничены z14 — дальше их рисовал 3D-слой темы, который мы убираем
	for (const layer of layers) delete layer.maxzoom;

	const bg = groundColor(style, scheme);
	const st = BUILDING_STEPS[scheme];
	const fill = rampedShift(bg, st.fill, st.chroma);
	const outline = rampedShift(bg, st.outline, st.chroma);
	// «крыша» в псевдо-объёме «Яркой» — на полшага светлее стен
	const top = rampedShift(bg, st.fill + 0.015, st.chroma);
	for (const layer of layers) {
		const paint = (layer.paint ??= {}) as Record<string, unknown>;
		const isTop = layer.id.includes("top");
		paint["fill-color"] = isTop ? top : fill;
		paint["fill-outline-color"] = outline;
		if (!isTop) paint["fill-opacity"] = 1;
		layer.minzoom = Math.min(layer.minzoom ?? 13, 13);
	}
	if (layers.length) return;
	const anyVector = style.layers.find((l) => "source-layer" in l && l["source-layer"]);
	const source = anyVector && "source" in anyVector ? anyVector.source : "openmaptiles";
	const layer: LayerSpecification = {
		id: "map-notes-buildings",
		type: "fill",
		source,
		"source-layer": "building",
		minzoom: 13,
		paint: { "fill-color": fill as never, "fill-outline-color": outline as never },
	};
	// под дорогами и подписями
	const firstRoad = style.layers.findIndex((l) => /(road|highway|tunnel|bridge|railway)/.test(l.id) || l.type === "symbol");
	style.layers.splice(firstRoad < 0 ? style.layers.length : firstRoad, 0, layer);
}

function roofColor(style: StyleSpecification, scheme: ColorScheme): string {
	const st = BUILDING_STEPS[scheme];
	return shiftLightness(groundColor(style, scheme), st.roof3d, st.chroma);
}

function applyBuildings(style: StyleSpecification, opts: VectorOptions, extrusionColor?: string) {
	// встроенные 3D-слои темы рисуют тёмные стены даже без наклона — убираем их всегда
	style.layers = style.layers.filter((l) => l.type !== "fill-extrusion");
	if (!opts.buildings3d) return;

	const flat = style.layers.find((l) => l.type === "fill" && l["source-layer"] === "building");
	const source = (flat && "source" in flat ? flat.source : null) ?? "openmaptiles";
	let color = extrusionColor ?? "#e3dfda";
	const flatColor = flat?.paint && (flat.paint as Record<string, unknown>)["fill-color"];
	if (!extrusionColor && typeof flatColor === "string") color = flatColor;

	const layer: LayerSpecification = {
		id: BUILDINGS_3D_LAYER,
		type: "fill-extrusion",
		source,
		"source-layer": "building",
		minzoom: 14,
		paint: {
			"fill-extrusion-color": color,
			"fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
			"fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
			"fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.9],
			// без градиента стены не уходят в чёрный
			"fill-extrusion-vertical-gradient": false,
		},
	};
	const firstSymbol = style.layers.findIndex((l) => l.type === "symbol");
	style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, layer);
	// мягкий свет: стены лишь немного темнее крыш
	style.light = {
		anchor: "viewport",
		color: opts.scheme === "jojo" ? "#f3e0f0" : "#ffffff",
		intensity: { light: 0.2, dark: 0.18, jojo: 0.22 }[opts.scheme],
		position: [1.15, 210, 30],
	};
}

// ---------------- работа с цветом ----------------

type RGBA = [number, number, number, number];

function parseColor(s: string): RGBA | null {
	const str = s.trim().toLowerCase();
	let m = /^#([0-9a-f]{3,8})$/.exec(str);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
		return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
	}
	m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(str);
	if (!m) return null;
	const parts = m[2].split(/[\s,/]+/).filter(Boolean).map((p) => parseFloat(p));
	if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
	const a = parts[3] ?? 1;
	if (m[1].startsWith("rgb")) return [parts[0], parts[1], parts[2], a];
	const [r, g, b] = hslToRgb(parts[0] / 360, parts[1] / 100, parts[2] / 100);
	return [r, g, b, a];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h /= 6;
	return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	if (s === 0) return [l * 255, l * 255, l * 255];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = (t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Применяет fn ко всем цветам внутри значения (в т.ч. внутри выражений interpolate/match) */
function mapColors(v: unknown, fn: (h: number, s: number, l: number, a: number) => string): unknown {
	if (typeof v === "string") {
		const rgba = parseColor(v);
		if (!rgba) return v;
		const [h, s, l] = rgbToHsl(rgba[0], rgba[1], rgba[2]);
		return fn(h, s, l, rgba[3]);
	}
	if (Array.isArray(v)) return v.map((x) => mapColors(x, fn));
	return v;
}

const hsla = (h: number, s: number, l: number, a: number) => {
	const [r, g, b] = hslToRgb(h, Math.min(1, s), Math.max(0, Math.min(1, l)));
	return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
};

// OKLab — перцептивно равномерное пространство: одинаковый шаг L выглядит одинаково на любом фоне
function srgbToLinear(c: number): number {
	c /= 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
	const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
	const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
	const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
	const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
	const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
	return [
		linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

/** Сдвигает перцептивную светлоту цвета, сохраняя оттенок (chroma — множитель насыщенности) */
function shiftLightness(color: string, dL: number, chroma = 1): string {
	const rgba = parseColor(color) ?? [242, 239, 233, 1];
	const [L, a, b] = rgbToOklab(rgba[0], rgba[1], rgba[2]);
	const [r, g, bl] = oklabToRgb(Math.max(0, Math.min(1, L + dL)), a * chroma, b * chroma);
	return `rgb(${r}, ${g}, ${bl})`;
}

// ---------------- тёмная схема: мягкий графит ----------------

/** Графитовый фон с лёгкой синевой; цветные объекты сохраняют оттенок, но приглушены */
const DARK_HUE = 222 / 360;

function applyDark(style: StyleSpecification) {
	for (const layer of style.layers) {
		const paint = layer.paint as Record<string, unknown> | undefined;
		if (!paint) continue;
		const isCasing = layer.id.includes("casing");
		for (const key of Object.keys(paint)) {
			if (!key.endsWith("-color")) continue;
			paint[key] = mapColors(paint[key], (h, s, l, a) => {
				// почти серые (в т.ч. светлые тёплые подложки) подкрашиваем в фирменный графит
				const chroma = s * (1 - Math.abs(2 * l - 1));
				const grey = chroma < 0.12;
				const hue = grey ? DARK_HUE : h;
				if (key === "text-color") return hsla(hue, grey ? 0.1 : s * 0.5, 0.6 + (1 - l) * 0.28, a);
				if (key === "text-halo-color") return hsla(DARK_HUE, 0.16, 0.22, Math.min(a, 0.85));
				if (key === "line-color") {
					// дороги чуть светлее фона, обводки — почти как фон
					if (isCasing) return hsla(hue, grey ? 0.12 : s * 0.35, 0.26, a);
					return hsla(hue, grey ? 0.1 : s * 0.55, 0.35 + (1 - l) * 0.2, a);
				}
				return hsla(hue, grey ? 0.14 : s * 0.42, 0.25 + (1 - l) * 0.34, a);
			});
		}
		if (layer.type === "raster") {
			paint["raster-brightness-max"] = 0.45;
			paint["raster-saturation"] = -0.5;
		}
		if (layer.type === "symbol") paint["icon-opacity"] = 0.85;
	}
}

// ---------------- схема JoJo ----------------

const JOJO = {
	bg: "#3a2552",
	land: "#432a5e",
	special: "#4f3168",
	green: "#3f7468",
	water: "#5fb3c0",
	waterText: "#d4f1f5",
	sand: "#e3cf9a",
	ice: "#dfeaf1",
	building: "#6f539b",
	buildingTop: "#7e62aa",
	buildingOutline: "#2c1a3f",
	casing: "#c9679a",
	major: "#ecc764",
	medium: "#ddaad2",
	minor: "#a593cf",
	rail: "#d48dc0",
	boundary: "#c9679a",
	text: "#fbf6ff",
	halo: "#2a1838",
};

/** Цвет слоя по его назначению (id слоёв OpenMapTiles похожи во всех темах) */
function jojoColor(id: string, type: string): string {
	const has = (...w: string[]) => w.some((x) => id.includes(x));
	// короткие слова сверяем целиком, иначе «service» попадает под «ice»
	const tokens = id.split(/[-_]/);
	if (type === "background") return JOJO.bg;
	if (has("water", "ferry")) return JOJO.water;
	if (has("boundary")) return JOJO.boundary;
	if (has("building-top")) return JOJO.buildingTop;
	if (has("building")) return JOJO.building;
	if (has("park", "wood", "grass", "wetland", "pitch", "cemetery", "garden")) return JOJO.green;
	if (has("sand")) return JOJO.sand;
	if (tokens.includes("ice") || has("glacier")) return JOJO.ice;
	if (has("hospital", "school", "aeroway", "railway", "commercial", "industrial")) {
		if (type === "line") return has("rail") ? JOJO.rail : JOJO.minor;
		return JOJO.special;
	}
	if (has("rail", "cablecar")) return JOJO.rail;
	if (type === "line") {
		if (has("casing")) return JOJO.casing;
		if (has("motorway", "trunk", "primary", "major")) return JOJO.major;
		if (has("secondary", "tertiary", "link", "street")) return JOJO.medium;
		return JOJO.minor;
	}
	return JOJO.land;
}

/** Фиолетовая земля, золотые магистрали, розовые обводки, бирюзовая вода, манга-подписи — в приглушённых тонах */
function applyJojo(style: StyleSpecification) {
	for (const layer of style.layers) {
		const id = layer.id.toLowerCase();
		const paint = (layer.paint ??= {}) as Record<string, unknown>;
		if (layer.type === "raster") {
			paint["raster-hue-rotate"] = 250;
			paint["raster-brightness-max"] = 0.5;
			paint["raster-saturation"] = -0.1;
			continue;
		}
		if (layer.type === "symbol") {
			const isWater = id.includes("water");
			paint["text-color"] = isWater ? JOJO.waterText : JOJO.text;
			paint["text-halo-color"] = JOJO.halo;
			paint["text-halo-width"] = 1.8;
			paint["text-halo-blur"] = 0;
			// крупные подписи — жирным, как в манге
			if (/(city|town|country|state|capital)/.test(id)) {
				(layer.layout as Record<string, unknown>)["text-font"] = ["Noto Sans Bold"];
				paint["text-color"] = JOJO.major;
			}
			continue;
		}
		const color = jojoColor(id, layer.type);
		for (const key of Object.keys(paint)) {
			if (!key.endsWith("-color")) continue;
			paint[key] = key === "fill-outline-color" ? JOJO.halo : color;
		}
		if (layer.type === "fill" && !("fill-color" in paint) && !("fill-pattern" in paint)) paint["fill-color"] = color;
		if (layer.type === "line" && !("line-color" in paint)) paint["line-color"] = color;
		if ("fill-pattern" in paint) paint["fill-opacity"] = 0.15;
	}
}
