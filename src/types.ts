export interface MapMarker {
	id: string;
	name: string;
	/** [lng, lat] */
	coords: [number, number];
	/** Путь к заметке в хранилище (может быть пустым) */
	notePath: string;
	/** Папка в списке меток; null — корень */
	folderId: string | null;
	color: string;
	/** Смещение карточки относительно метки, в пикселях экрана */
	cardOffset: [number, number];
	cardSize: [number, number];
	cardOpen: boolean;
	/** скрыта с карты (в списке остаётся) */
	hidden?: boolean;
}

export interface MarkerFolder {
	id: string;
	name: string;
	parentId: string | null;
	collapsed: boolean;
	/** все метки папки (и вложенных) скрыты с карты */
	hidden?: boolean;
}

/** Направление связи: none — без стрелок, forward — к to, backward — к from, both — в обе стороны */
export type LinkDirection = "none" | "forward" | "backward" | "both";

/** Пунктирная связь между двумя метками */
export interface MarkerLink {
	id: string;
	/** id метки-начала */
	from: string;
	/** id метки-конца */
	to: string;
	direction: LinkDirection;
	color: string;
	/** надпись посередине линии, "" — без надписи */
	label: string;
}

export interface PluginSettings {
	tileProvider: string;
	customTileUrl: string;
	/** тема векторной карты OpenFreeMap */
	vectorTheme: string;
	/** язык подписей векторной карты */
	labelLang: string;
	/** цветовая схема векторной карты (для всех тем) */
	colorScheme: "light" | "dark" | "jojo";
	/** объёмные здания на векторной карте (для всех тем) */
	buildings3d: boolean;
	/** online — тайлы из сети; offline — из скачанных областей */
	mapMode: "online" | "offline";
	/** В офлайн-режиме брать из сети тайлы, которых нет среди скачанных */
	offlineNetworkFallback: boolean;
	/** Максимальный масштаб при скачивании области */
	offlineMaxZoom: number;
	defaultCenter: [number, number];
	defaultZoom: number;
	flyDuration: number;
	flyZoom: number;
	openCardOnFly: boolean;
	sidebarOpen: boolean;
}

export interface PluginData {
	settings: PluginSettings;
	markers: MapMarker[];
	folders: MarkerFolder[];
	links: MarkerLink[];
	lastCamera: { center: [number, number]; zoom: number } | null;
	regions: OfflineRegion[];
}

/** Скачанная область карты */
export interface OfflineRegion {
	id: string;
	name: string;
	/** ключ подложки, для которой скачаны тайлы */
	providerKey: string;
	providerName: string;
	/** шаблоны URL тайлов — чтобы обновлять область, даже если подложку сменили */
	tiles: string[];
	/** [запад, юг, восток, север] */
	bounds: [number, number, number, number];
	maxZoom: number;
	tileCount: number;
	bytes: number;
	failed: number;
	downloadedAt: number;
}

export const MARKER_COLORS = [
	"#e5484d", "#f76b15", "#ffc53d", "#30a46c",
	"#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d8d8d",
];

export const DEFAULT_SETTINGS: PluginSettings = {
	tileProvider: "osm",
	customTileUrl: "",
	vectorTheme: "liberty",
	labelLang: "ru",
	colorScheme: "light",
	buildings3d: false,
	mapMode: "online",
	offlineNetworkFallback: false,
	offlineMaxZoom: 15,
	defaultCenter: [37.6176, 55.7558],
	defaultZoom: 11,
	flyDuration: 500,
	flyZoom: 15,
	openCardOnFly: true,
	sidebarOpen: true,
};

export const DEFAULT_CARD_SIZE: [number, number] = [300, 220];
export const DEFAULT_CARD_OFFSET: [number, number] = [40, -260];

export function uid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface TileProvider {
	/** уникальный ключ — под ним хранятся скачанные тайлы */
	key: string;
	name: string;
	tiles: string[];
	attribution: string;
	maxzoom: number;
}

const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
export const TILE_PROVIDERS: Record<string, TileProvider> = {
	osm: {
		key: "osm",
		name: "OpenStreetMap",
		tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
		attribution: OSM_ATTR,
		maxzoom: 19,
	},
};

export function resolveTileProvider(s: PluginSettings): TileProvider {
	if (s.tileProvider === "custom" && s.customTileUrl) {
		return { key: "custom:" + s.customTileUrl, name: "Свой URL", tiles: [s.customTileUrl], attribution: OSM_ATTR, maxzoom: 19 };
	}
	return TILE_PROVIDERS[s.tileProvider] ?? TILE_PROVIDERS.osm;
}
