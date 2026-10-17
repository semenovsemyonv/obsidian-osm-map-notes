import { Events, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce } from "obsidian";
import {
	DEFAULT_CARD_OFFSET, DEFAULT_CARD_SIZE, DEFAULT_SETTINGS, MARKER_COLORS,
	LinkDirection, MapMarker, MarkerFolder, MarkerLink, PluginData, PluginSettings, TileProvider, resolveTileProvider, uid,
} from "./types";
import { OfflineManager } from "./offline";
import { MapView, VIEW_TYPE_MAP } from "./mapView";
import { MapSettingTab } from "./settings";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css";

export default class MapNotesPlugin extends Plugin {
	data!: PluginData;
	/** "changed" — метки/папки изменились; "note-modified" (path) — заметка изменилась; "tiles-changed" — сменился источник тайлов */
	events = new Events();

	private saveDebounced = debounce(() => this.saveData(this.data), 400, true);

	settings!: PluginSettings;
	offline!: OfflineManager;

	async onload() {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
			markers: raw?.markers ?? [],
			folders: raw?.folders ?? [],
			links: raw?.links ?? [],
			lastCamera: raw?.lastCamera ?? null,
			regions: raw?.regions ?? [],
		};
		this.settings = this.data.settings;
		delete (this.settings as unknown as Record<string, unknown>).themeOptions; // старый формат (по темам)
		// эти параметры больше не настраиваются — всегда берём значения по умолчанию
		for (const k of ["defaultCenter", "defaultZoom", "flyDuration", "flyZoom"] as const) {
			(this.settings as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
		}
		this.offline = new OfflineManager(this);
		this.register(() => this.offline.unload());

		// Obsidian подключает только styles.css плагина, поэтому стили MapLibre встраиваем сами
		const style = document.head.createEl("style", { attr: { id: "map-notes-maplibre-css" } });
		style.textContent = maplibreCss;
		this.register(() => style.remove());

		this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf, this));
		this.addRibbonIcon("map-pin", "Открыть карту заметок", () => this.activateView());
		this.addCommand({ id: "open-map", name: "Открыть карту", callback: () => this.activateView() });
		this.addCommand({
			id: "toggle-marker-list",
			name: "Показать/скрыть список меток",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MapView);
				if (!view) return false;
				if (!checking) view.toggleSidebar();
				return true;
			},
		});
		this.addCommand({ id: "show-all-markers", name: "Показать все скрытые метки", callback: () => this.showAll() });
		this.addSettingTab(new MapSettingTab(this.app, this));

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile) this.events.trigger("note-modified", file.path);
		}));
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_MAP)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_MAP, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	currentProvider(): TileProvider {
		return resolveTileProvider(this.settings);
	}

	/** Включены ли сейчас 3D-здания (только для векторной карты онлайн) */
	is3d(): boolean {
		const s = this.settings;
		return s.tileProvider === "vector" && s.mapMode === "online" && s.buildings3d;
	}

	setMapMode(mode: "online" | "offline") {
		this.settings.mapMode = mode;
		this.save(false);
		this.events.trigger("tiles-changed");
		this.events.trigger("offline-changed");
	}

	// ---------- хранилище ----------

	save(notify = true) {
		this.saveDebounced();
		if (notify) this.events.trigger("changed");
	}

	getMarker(id: string): MapMarker | undefined {
		return this.data.markers.find((m) => m.id === id);
	}

	addMarker(coords: [number, number], name: string, notePath: string, folderId: string | null = null): MapMarker {
		const marker: MapMarker = {
			id: uid(),
			name,
			coords,
			notePath,
			folderId,
			color: MARKER_COLORS[this.data.markers.length % MARKER_COLORS.length],
			cardOffset: [...DEFAULT_CARD_OFFSET],
			cardSize: [...DEFAULT_CARD_SIZE],
			cardOpen: true,
		};
		this.data.markers.push(marker);
		this.save();
		return marker;
	}

	updateMarker(id: string, patch: Partial<MapMarker>, notify = true) {
		const m = this.getMarker(id);
		if (!m) return;
		Object.assign(m, patch);
		this.save(notify);
	}

	/** Удаляет метку вместе с её связями */
	deleteMarker(id: string) {
		this.data.markers = this.data.markers.filter((m) => m.id !== id);
		this.data.links = this.data.links.filter((l) => l.from !== id && l.to !== id);
		this.save();
	}

	// ---------- связи ----------

	getLink(id: string): MarkerLink | undefined {
		return this.data.links.find((l) => l.id === id);
	}

	/** Связь между двумя метками в любом направлении */
	findLink(a: string, b: string): MarkerLink | undefined {
		return this.data.links.find((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
	}

	addLink(from: string, to: string, color: string, direction: LinkDirection = "forward"): MarkerLink {
		const link: MarkerLink = { id: uid(), from, to, direction, color, label: "" };
		this.data.links.push(link);
		this.save();
		return link;
	}

	updateLink(id: string, patch: Partial<MarkerLink>) {
		const l = this.getLink(id);
		if (!l) return;
		Object.assign(l, patch);
		this.save();
	}

	deleteLink(id: string) {
		this.data.links = this.data.links.filter((l) => l.id !== id);
		this.save();
	}

	addFolder(name: string, parentId: string | null = null): MarkerFolder {
		const folder: MarkerFolder = { id: uid(), name, parentId, collapsed: false };
		this.data.folders.push(folder);
		this.save();
		return folder;
	}

	updateFolder(id: string, patch: Partial<MarkerFolder>) {
		const f = this.data.folders.find((x) => x.id === id);
		if (!f) return;
		Object.assign(f, patch);
		this.save();
	}

	/** Удаляет папку; содержимое (метки и подпапки) поднимается к родителю */
	deleteFolder(id: string) {
		const f = this.data.folders.find((x) => x.id === id);
		if (!f) return;
		for (const m of this.data.markers) if (m.folderId === id) m.folderId = f.parentId;
		for (const sub of this.data.folders) if (sub.parentId === id) sub.parentId = f.parentId;
		this.data.folders = this.data.folders.filter((x) => x.id !== id);
		this.save();
	}

	/** Скрыта ли папка — сама или через одну из родительских */
	isFolderHidden(folderId: string | null): boolean {
		let cur = folderId;
		while (cur) {
			const f = this.data.folders.find((x) => x.id === cur);
			if (!f) return false;
			if (f.hidden) return true;
			cur = f.parentId;
		}
		return false;
	}

	/** Видна ли метка на карте с учётом скрытых папок */
	isMarkerVisible(m: MapMarker): boolean {
		return !m.hidden && !this.isFolderHidden(m.folderId);
	}

	/** Показать всё: снимает скрытие со всех меток и папок */
	showAll() {
		for (const m of this.data.markers) m.hidden = false;
		for (const f of this.data.folders) f.hidden = false;
		this.save();
	}

	/** true, если candidate — это folderId или его потомок */
	isFolderInside(candidate: string | null, folderId: string): boolean {
		let cur = candidate;
		while (cur) {
			if (cur === folderId) return true;
			cur = this.data.folders.find((f) => f.id === cur)?.parentId ?? null;
		}
		return false;
	}

	private onRename(file: TAbstractFile, oldPath: string) {
		let changed = false;
		for (const m of this.data.markers) {
			if (m.notePath === oldPath) {
				m.notePath = file.path;
				changed = true;
			} else if (m.notePath.startsWith(oldPath + "/")) {
				m.notePath = file.path + m.notePath.slice(oldPath.length);
				changed = true;
			}
		}
		if (changed) this.save();
	}
}
