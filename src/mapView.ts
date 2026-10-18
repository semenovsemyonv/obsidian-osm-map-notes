import {
	Component, ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon,
} from "obsidian";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import type MapNotesPlugin from "./main";
import { DEFAULT_CARD_OFFSET, DEFAULT_CARD_SIZE, LinkDirection, MapMarker, MarkerLink } from "./types";
import { flyPathScreens, fromMerc, rectEdgePoint, toMerc } from "./geo";
import { ColorModal, ConfirmModal, NotePickerModal, PromptModal } from "./modals";
import { Sidebar } from "./sidebar";
import { DownloadJob, OFFLINE_PROTOCOL } from "./offline";
import { OfflineModal } from "./offlineModal";
import { loadVectorStyle } from "./vectorStyle";
import { GeoResult, geocode } from "./geocoder";

export const VIEW_TYPE_MAP = "gis-map-notes-view";

async function buildStyle(plugin: MapNotesPlugin): Promise<StyleSpecification> {
	const s = plugin.settings;
	// векторная карта — только онлайн; офлайн всегда работает со скачанными растровыми тайлами
	if (s.tileProvider === "vector" && s.mapMode === "online") {
		try {
			return await loadVectorStyle(s.vectorTheme, s.labelLang, { scheme: s.colorScheme, buildings3d: s.buildings3d });
		} catch (e) {
			console.error(e);
			new Notice("Не удалось загрузить векторную карту — показываю OpenStreetMap");
		}
	}
	const p = plugin.currentProvider();
	let tiles = p.tiles;
	let maxzoom = p.maxzoom;
	if (s.mapMode === "offline") {
		tiles = [`${OFFLINE_PROTOCOL}://${encodeURIComponent(p.key)}/{z}/{x}/{y}`];
		// выше скачанного масштаба карта просто растягивает имеющиеся тайлы
		if (!s.offlineNetworkFallback) maxzoom = plugin.offline.maxDownloadedZoom(p.key) ?? p.maxzoom;
	}
	return {
		version: 8,
		sources: {
			tiles: { type: "raster", tiles, tileSize: 256, maxzoom, attribution: p.attribution },
		},
		layers: [
			{ id: "background", type: "background", paint: { "background-color": "#e9e6df" } },
			{ id: "tiles", type: "raster", source: "tiles" },
		],
	};
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** расстояние от точки метки до центра её «головки», px */
const PIN_HEAD_Y = 17;
/** отступ линии связи от центра «головки» метки */
const LINK_GAP = 15;
const ARROW_LEN = 11;
const ARROW_HALF_W = 6;
/** кривизна траектории перелёта (как в MapLibre): больше — сильнее отдаление посередине */
const FLY_CURVE = 1.42;
/** самый долгий перелёт, мс — даже через полмира */
const FLY_MAX_DURATION = 6000;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	el.classList.add(cls);
	return el;
}

interface MarkerUI {
	pinEl: HTMLElement;
	labelEl: HTMLElement;
	card?: CardUI;
}

interface LinkUI {
	g: SVGGElement;
	hitEl: SVGLineElement;
	lineEl: SVGLineElement;
	arrowStartEl: SVGPolygonElement;
	arrowEndEl: SVGPolygonElement;
	labelEl: SVGTextElement;
}

interface CardUI {
	el: HTMLElement;
	titleEl: HTMLElement;
	bodyEl: HTMLElement;
	lineEl: SVGLineElement;
	dotEl: SVGCircleElement;
	component: Component;
	renderedPath: string | null;
	resizeObserver: ResizeObserver;
}

export class MapView extends ItemView {
	plugin: MapNotesPlugin;
	map: maplibregl.Map | null = null;

	private wrapEl!: HTMLElement;
	private mapEl!: HTMLElement;
	private overlayEl!: HTMLElement;
	private svgEl!: SVGSVGElement;
	private linksEl!: SVGGElement;
	private pinsEl!: HTMLElement;
	private cardsEl!: HTMLElement;
	private addBtn!: HTMLElement;
	private modeBtn!: HTMLElement;
	private navControl: maplibregl.NavigationControl | null = null;
	private sidebar!: Sidebar;

	private ui = new Map<string, MarkerUI>();
	private linkUI = new Map<string, LinkUI>();
	private addMode = false;
	/** режим создания связи: id метки-начала */
	private linkFrom: string | null = null;
	private linkDraftEl: SVGLineElement | null = null;
	private pointer: [number, number] | null = null;

	private searchInput!: HTMLInputElement;
	private searchResultsEl!: HTMLElement;
	private searchResults: GeoResult[] = [];
	private searchSeq = 0;
	/** временная метка найденного адреса */
	private searchPin: { result: GeoResult; el: HTMLElement } | null = null;
	private zTop = 10;
	private flyToken = 0;
	private resizeObserver: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MapNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType() { return VIEW_TYPE_MAP; }
	getDisplayText() { return "Карта"; }
	getIcon() { return "map-pin"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("gis-root");

		this.wrapEl = root.createDiv("gis-map-wrap");
		this.mapEl = this.wrapEl.createDiv("gis-map");
		this.overlayEl = this.wrapEl.createDiv("gis-overlay");
		this.svgEl = document.createElementNS(SVG_NS, "svg");
		this.svgEl.classList.add("gis-lines");
		this.overlayEl.appendChild(this.svgEl);
		// связи рисуются под линиями карточек
		this.linksEl = svgEl("g", "gis-links");
		this.svgEl.appendChild(this.linksEl);
		this.pinsEl = this.overlayEl.createDiv("gis-pins");
		this.cardsEl = this.overlayEl.createDiv("gis-cards");

		this.buildToolbar();
		this.sidebar = new Sidebar(this, root);
		this.sidebar.setOpen(this.plugin.settings.sidebarOpen, false);

		this.registerEvent(this.plugin.events.on("changed", () => this.sync()));
		this.registerEvent(this.plugin.events.on("note-modified", (path: string) => this.onNoteModified(path)));
		this.registerDomEvent(root, "keydown", (e) => {
			if (e.key !== "Escape") return;
			if (this.addMode) this.setAddMode(false);
			if (this.linkFrom) this.cancelLink();
		});
		this.registerDomEvent(this.wrapEl, "pointermove", (e) => {
			const r = this.wrapEl.getBoundingClientRect();
			this.pointer = [e.clientX - r.left, e.clientY - r.top];
			if (this.linkFrom) this.updateLinkDraft();
		});
		this.registerFileDrop();
		this.registerEvent(this.plugin.events.on("offline-changed", () => this.updateModeButton()));
		this.registerEvent(this.plugin.events.on("offline-progress", (job: DownloadJob) => this.updateModeButton(job)));
		this.registerEvent(this.plugin.events.on("tiles-changed", async () => {
			const style = await buildStyle(this.plugin);
			this.map?.setStyle(style, { diff: false });
			this.applyCameraMode(true);
			this.updateSchemeDecor();
		}));

		this.sidebar.render();
		this.updateSchemeDecor();
		await this.initMap();
	}

	async onClose() {
		this.map?.stop();
		this.resizeObserver?.disconnect();
		for (const id of [...this.ui.keys()]) this.removeMarkerUI(id);
		this.map?.remove();
		this.map = null;
	}

	// ---------------- карта ----------------

	private async initMap() {
		const s = this.plugin.settings;
		const cam = this.plugin.data.lastCamera;
		const style = await buildStyle(this.plugin);
		if (!this.contentEl.isConnected) return;
		let map: maplibregl.Map;
		try {
			map = new maplibregl.Map({
				container: this.mapEl,
				style,
				center: cam?.center ?? s.defaultCenter,
				zoom: cam?.zoom ?? s.defaultZoom,
				attributionControl: { compact: true },
				maxPitch: 70,
			});
		} catch (e) {
			console.error(e);
			this.showPlaceholder("Не удалось создать карту: WebGL недоступен.");
			return;
		}
		this.map = map;
		this.applyCameraMode(false);
		map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

		map.on("move", () => this.updatePositions());
		map.on("moveend", () => {
			const c = map.getCenter();
			this.plugin.data.lastCamera = { center: [c.lng, c.lat], zoom: map.getZoom() };
			this.plugin.save(false);
		});
		map.on("click", (e) => {
			this.showSearchResults(false);
			if (this.linkFrom) {
				this.cancelLink();
				return;
			}
			if (!this.addMode) return;
			this.setAddMode(false);
			this.startAddMarker([e.lngLat.lng, e.lngLat.lat]);
		});
		// в 3D правая кнопка вращает карту — меню показываем только на «чистый» клик
		let rightDown: [number, number] | null = null;
		map.on("mousedown", (e) => {
			if (e.originalEvent.button === 2) rightDown = [e.point.x, e.point.y];
		});
		map.on("contextmenu", (e) => {
			const moved = rightDown && Math.hypot(e.point.x - rightDown[0], e.point.y - rightDown[1]) > 5;
			rightDown = null;
			if (moved) return;
			const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Добавить метку здесь").setIcon("map-pin")
				.onClick(() => this.startAddMarker(lngLat)));
			menu.addItem((i) => i.setTitle("Скопировать координаты").setIcon("copy")
				.onClick(() => {
					navigator.clipboard.writeText(`${lngLat[1].toFixed(6)}, ${lngLat[0].toFixed(6)}`);
					new Notice("Координаты скопированы");
				}));
			menu.showAtMouseEvent(e.originalEvent);
		});

		this.resizeObserver = new ResizeObserver(() => {
			map.resize();
			this.updatePositions();
		});
		this.resizeObserver.observe(this.wrapEl);

		this.sync();
	}

	/**
	 * 3D-режим: разрешаем наклон и поворот (правая кнопка мыши / Ctrl+перетаскивание)
	 * и наклоняем камеру; в 2D — возвращаем карту «сверху» и севером вверх.
	 */
	private applyCameraMode(animate: boolean) {
		const map = this.map;
		if (!map) return;
		const on = this.plugin.is3d();
		if (this.navControl) map.removeControl(this.navControl);
		this.navControl = new maplibregl.NavigationControl({ showCompass: on, visualizePitch: on });
		map.addControl(this.navControl, "bottom-left");
		if (on) {
			map.dragRotate.enable();
			map.touchZoomRotate.enableRotation();
			map.touchPitch.enable();
			map.keyboard.enableRotation();
			if (map.getPitch() < 10) map.easeTo({ pitch: 55, duration: animate ? 600 : 0 });
		} else {
			map.dragRotate.disable();
			map.touchZoomRotate.disableRotation();
			map.touchPitch.disable();
			map.keyboard.disableRotation();
			if (map.getPitch() !== 0 || map.getBearing() !== 0) {
				map.easeTo({ pitch: 0, bearing: 0, duration: animate ? 600 : 0 });
			}
		}
	}

	/** Оформление интерфейса под схему JoJo: карточки, кнопки и «ゴゴゴ» по краям карты */
	private updateSchemeDecor() {
		const s = this.plugin.settings;
		const jojo = s.tileProvider === "vector" && s.mapMode === "online" && s.colorScheme === "jojo";
		this.contentEl.toggleClass("gis-scheme-jojo", jojo);
		this.wrapEl.querySelector(".gis-menacing")?.remove();
		if (!jojo) return;
		const decor = this.wrapEl.createDiv("gis-menacing");
		const spots = [[6, 22], [3, 60], [9, 84], [88, 30], [93, 68], [84, 88]];
		spots.forEach(([x, y], i) => {
			const el = decor.createSpan({ text: "ゴ", cls: "gis-menacing-char" });
			el.style.left = `${x}%`;
			el.style.top = `${y}%`;
			el.style.animationDelay = `${i * -0.7}s`;
			el.style.fontSize = `${34 + (i % 3) * 10}px`;
		});
	}

	private showPlaceholder(text: string) {
		const ph = this.mapEl.createDiv("gis-placeholder");
		ph.createDiv({ text, cls: "gis-placeholder-text" });
		const btn = ph.createEl("button", { text: "Открыть настройки", cls: "mod-cta" });
		btn.onclick = () => {
			const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
			setting.open();
			setting.openTabById(this.plugin.manifest.id);
		};
	}

	private unproject(x: number, y: number): [number, number] {
		const ll = this.map!.unproject([x, y]);
		return [ll.lng, ll.lat];
	}

	private project(coords: number[]): [number, number] | null {
		if (!this.map) return null;
		const p = this.map.project(coords as [number, number]);
		return [p.x, p.y];
	}

	// ---------------- панель инструментов ----------------

	private buildToolbar() {
		const bar = this.wrapEl.createDiv("gis-toolbar");
		this.addBtn = bar.createDiv({ cls: "gis-tool-btn", attr: { "aria-label": "Добавить метку (клик по карте)" } });
		setIcon(this.addBtn, "map-pin-plus");
		this.addBtn.createSpan({ text: "Метка" });
		this.addBtn.onclick = () => this.setAddMode(!this.addMode);

		this.buildSearch(bar);

		this.modeBtn = bar.createDiv({ cls: "gis-tool-btn gis-mode-btn", attr: { "aria-label": "Режим карты и офлайн-карты" } });
		this.modeBtn.onclick = () => new OfflineModal(this.app, this.plugin, this).open();
		this.updateModeButton();
	}

	updateModeButton(job: DownloadJob | null = this.plugin.offline.job) {
		const offline = this.plugin.settings.mapMode === "offline";
		this.modeBtn.empty();
		this.modeBtn.toggleClass("is-offline", offline);
		setIcon(this.modeBtn.createSpan("gis-mode-icon"), offline ? "hard-drive-download" : "wifi");
		this.modeBtn.createSpan({ text: offline ? "Офлайн" : "Онлайн" });
		if (job && !job.cancelled && job.done < job.total) {
			this.modeBtn.createSpan({ cls: "gis-mode-progress", text: `${Math.floor((job.done / job.total) * 100)}%` });
		}
	}

	/** Видимая область карты: [запад, юг, восток, север] */
	getVisibleBounds(): [number, number, number, number] | null {
		if (!this.map) return null;
		const b = this.map.getBounds();
		return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
	}

	fitBounds(b: [number, number, number, number]) {
		this.map?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: this.plugin.settings.flyDuration });
	}

	setAddMode(on: boolean) {
		if (on && this.linkFrom) this.cancelLink();
		this.addMode = on;
		this.addBtn.toggleClass("is-active", on);
		this.wrapEl.toggleClass("is-adding", on);
		if (on) new Notice("Кликните по карте, чтобы поставить метку. Esc — отмена.", 2500);
	}

	toggleSidebar() {
		this.sidebar.setOpen(!this.sidebar.isOpen);
	}

	// ---------------- добавление меток ----------------

	startAddMarker(coords: [number, number], folderId: string | null = null, initialName = "", onAdded?: () => void) {
		const modal = new NotePickerModal(this.app, async (choice, query) => {
			if (choice.kind === "file") {
				this.plugin.addMarker(coords, choice.file.basename, choice.file.path, folderId);
			} else if (choice.kind === "new") {
				const name = query || "Новая метка";
				const file = await this.createNote(name, coords);
				this.plugin.addMarker(coords, name, file?.path ?? "", folderId);
			} else {
				this.plugin.addMarker(coords, query || "Метка", "", folderId);
			}
			onAdded?.();
		});
		modal.open();
		if (initialName) {
			modal.inputEl.value = initialName;
			modal.inputEl.dispatchEvent(new Event("input"));
			modal.inputEl.select();
		}
	}

	// ---------------- поиск адреса ----------------

	private buildSearch(bar: HTMLElement) {
		const box = bar.createDiv("gis-search");
		setIcon(box.createSpan("gis-search-icon"), "search");
		this.searchInput = box.createEl("input", {
			type: "search", cls: "gis-search-input",
			attr: { placeholder: "Поиск адреса…", spellcheck: "false" },
		});
		this.searchResultsEl = box.createDiv("gis-search-results");
		this.showSearchResults(false);

		this.searchInput.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				this.runSearch();
			} else if (e.key === "Escape") {
				this.showSearchResults(false);
				this.searchInput.blur();
			}
		});
		this.searchInput.addEventListener("input", () => {
			if (this.searchInput.value.trim()) return;
			this.searchSeq++;
			this.searchResults = [];
			this.showSearchResults(false);
			this.clearSearchPin();
		});
		this.searchInput.addEventListener("focus", () => {
			if (this.searchResults.length) this.showSearchResults(true);
		});
	}

	private showSearchResults(show: boolean) {
		this.searchResultsEl.toggle(show);
	}

	private async runSearch() {
		const query = this.searchInput.value.trim();
		if (!query) return;
		const seq = ++this.searchSeq;
		const list = this.searchResultsEl;
		list.empty();
		list.createDiv({ cls: "gis-search-status", text: "Ищу…" });
		this.showSearchResults(true);
		let results: GeoResult[];
		try {
			results = await geocode(query, this.plugin.settings.labelLang);
		} catch (e) {
			console.error(e);
			if (seq !== this.searchSeq) return;
			list.empty();
			list.createDiv({ cls: "gis-search-status", text: "Не удалось выполнить поиск — проверьте подключение к интернету" });
			return;
		}
		if (seq !== this.searchSeq) return; // успели начать новый поиск
		this.searchResults = results;
		list.empty();
		if (!results.length) {
			list.createDiv({ cls: "gis-search-status", text: "Ничего не найдено. Попробуйте «город, улица, дом» без сокращений." });
			return;
		}
		results.forEach((r, i) => {
			const item = list.createDiv({ cls: "gis-search-item" + (i === 0 ? " is-active" : "") });
			const text = item.createDiv("gis-search-item-text");
			text.createDiv({ cls: "gis-search-item-name", text: r.name });
			text.createDiv({ cls: "gis-search-item-detail", text: r.detail });
			const add = item.createDiv({ cls: "clickable-icon gis-search-item-add", attr: { "aria-label": "Добавить метку сюда" } });
			setIcon(add, "map-pin-plus");
			item.onclick = (e) => {
				list.querySelectorAll(".is-active").forEach((el) => el.removeClass("is-active"));
				item.addClass("is-active");
				this.showSearchResult(r);
				if ((e.target as HTMLElement).closest(".gis-search-item-add")) this.addMarkerAtSearch();
				this.showSearchResults(false);
			};
		});
		// сразу показываем лучший результат, список остаётся открытым для выбора
		this.showSearchResult(results[0]);
	}

	private showSearchResult(r: GeoResult) {
		const map = this.map;
		if (!map) return;
		this.clearSearchPin();
		const el = this.pinsEl.createDiv("gis-search-pin");
		el.createDiv("gis-search-pin-dot");
		const bubble = el.createDiv("gis-search-bubble");
		const head = bubble.createDiv("gis-search-bubble-head");
		head.createDiv({ cls: "gis-search-bubble-name", text: r.name });
		const close = head.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Убрать" } });
		setIcon(close, "x");
		close.onclick = () => this.clearSearchPin();
		if (r.detail) bubble.createDiv({ cls: "gis-search-bubble-detail", text: r.detail });
		const btn = bubble.createEl("button", { cls: "mod-cta", text: "Добавить метку" });
		btn.onclick = () => this.addMarkerAtSearch();
		this.searchPin = { result: r, el };
		this.updatePositions();

		const padding = { top: 90, bottom: 60, left: 60, right: 60 + this.sidebar.coveredWidth };
		// город, район, длинная улица — показываем целиком, дом — крупно.
		// fitBounds, а не easeTo: padding в easeTo остался бы у карты навсегда
		const big = r.bounds && (r.bounds[2] - r.bounds[0] > 0.003 || r.bounds[3] - r.bounds[1] > 0.002);
		const d = 1e-5;
		const [lng, lat] = r.coords;
		const b = big ? r.bounds! : [lng - d, lat - d, lng + d, lat + d];
		map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
			padding, maxZoom: big ? 17 : Math.max(map.getZoom(), 17), duration: 800,
		});
	}

	private addMarkerAtSearch() {
		const r = this.searchPin?.result;
		if (!r) return;
		this.startAddMarker([...r.coords], null, r.name, () => this.clearSearchPin());
	}

	private clearSearchPin() {
		this.searchPin?.el.remove();
		this.searchPin = null;
	}

	private async createNote(name: string, coords: [number, number]): Promise<TFile | null> {
		const parent = this.app.fileManager.getNewFileParent("");
		const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Новая метка";
		let path = normalizePath(`${parent.path}/${safe}.md`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${parent.path}/${safe} ${i}.md`);
		}
		try {
			return await this.app.vault.create(path,
				`---\nlocation: "${coords[1].toFixed(6)}, ${coords[0].toFixed(6)}"\n---\n\n# ${name}\n\n`);
		} catch (e) {
			console.error(e);
			new Notice("Не удалось создать заметку");
			return null;
		}
	}

	/** Перетаскивание заметки из проводника Obsidian прямо на карту */
	private registerFileDrop() {
		const getDraggedFile = (): TFile | null => {
			const dm = (this.app as unknown as { dragManager?: { draggable?: { type?: string; file?: unknown } } }).dragManager;
			const d = dm?.draggable;
			return d?.type === "file" && d.file instanceof TFile && d.file.extension === "md" ? d.file : null;
		};
		this.registerDomEvent(this.wrapEl, "dragover", (e) => {
			if (!this.map || !getDraggedFile()) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});
		this.registerDomEvent(this.wrapEl, "drop", (e) => {
			const file = getDraggedFile();
			if (!this.map || !file) return;
			e.preventDefault();
			const r = this.wrapEl.getBoundingClientRect();
			const coords = this.unproject(e.clientX - r.left, e.clientY - r.top);
			this.plugin.addMarker(coords, file.basename, file.path);
		});
	}

	// ---------------- синхронизация DOM с данными ----------------

	sync() {
		// скрытые метки (и метки скрытых папок) убираем с карты, состояние карточек сохраняется
		const markers = this.plugin.data.markers.filter((m) => this.plugin.isMarkerVisible(m));
		this.contentEl.toggleClass("gis-labels-always", this.plugin.settings.alwaysShowLabels);
		const alive = new Set(markers.map((m) => m.id));
		for (const id of [...this.ui.keys()]) if (!alive.has(id)) this.removeMarkerUI(id);

		if (this.map) {
			for (const m of markers) {
				let ui = this.ui.get(m.id);
				if (!ui) {
					ui = this.createPin(m);
					this.ui.set(m.id, ui);
				}
				ui.pinEl.style.setProperty("--pin-color", m.color);
				ui.labelEl.setText(m.name);
				ui.pinEl.toggleClass("has-card", m.cardOpen);
				ui.pinEl.toggleClass("is-locked", !!m.locked);

				if (m.cardOpen && !ui.card) ui.card = this.createCard(m);
				if (!m.cardOpen && ui.card) this.removeCard(ui);
				if (ui.card) this.updateCard(m, ui.card);
			}
			this.syncLinks();
			this.updatePositions();
		}
		this.sidebar.render();
	}

	private removeMarkerUI(id: string) {
		const ui = this.ui.get(id);
		if (!ui) return;
		if (ui.card) this.removeCard(ui);
		ui.pinEl.remove();
		this.ui.delete(id);
	}

	updatePositions() {
		if (!this.map) return;
		const w = this.wrapEl.clientWidth;
		const h = this.wrapEl.clientHeight;
		const margin = 400;
		for (const m of this.plugin.data.markers) {
			const ui = this.ui.get(m.id);
			if (!ui) continue;
			const p = this.project(m.coords);
			if (!p) continue;
			const [x, y] = p;
			const visible = x > -margin && y > -margin && x < w + margin && y < h + margin;
			ui.pinEl.style.display = visible || ui.card ? "" : "none";
			ui.pinEl.style.transform = `translate(${x}px, ${y}px)`;

			const card = ui.card;
			if (!card) continue;
			const cx = x + m.cardOffset[0];
			const cy = y + m.cardOffset[1];
			const [cw, ch] = m.cardSize;
			card.el.style.transform = `translate(${cx}px, ${cy}px)`;

			// линия идёт от «головки» метки к ближайшей точке края карточки
			const headY = y - PIN_HEAD_Y;
			const edge = rectEdgePoint(x, headY, cx, cy, cw, ch);
			if (edge) {
				card.lineEl.setAttribute("x1", String(x));
				card.lineEl.setAttribute("y1", String(headY));
				card.lineEl.setAttribute("x2", String(edge[0]));
				card.lineEl.setAttribute("y2", String(edge[1]));
				card.dotEl.setAttribute("cx", String(edge[0]));
				card.dotEl.setAttribute("cy", String(edge[1]));
				card.lineEl.style.display = "";
				card.dotEl.style.display = "";
			} else {
				card.lineEl.style.display = "none";
				card.dotEl.style.display = "none";
			}
		}
		this.updateLinkPositions();
		this.updateLinkDraft();
		if (this.searchPin) {
			const p = this.project(this.searchPin.result.coords);
			if (p) this.searchPin.el.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
		}
	}

	// ---------------- метки ----------------

	private createPin(m: MapMarker): MarkerUI {
		const pinEl = this.pinsEl.createDiv("gis-pin");
		pinEl.dataset.id = m.id;
		const body = pinEl.createDiv("gis-pin-body");
		body.createDiv("gis-pin-head").createDiv("gis-pin-dot");
		pinEl.createDiv("gis-pin-shadow");
		const labelEl = pinEl.createDiv("gis-pin-label");

		// клик — открыть/закрыть карточку, перетаскивание — переместить метку
		body.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !this.map) return;
			e.stopPropagation();
			if (this.linkFrom) {
				e.preventDefault();
				this.finishLink(m.id);
				return;
			}
			const marker = this.plugin.getMarker(m.id);
			if (!marker) return;
			const startX = e.clientX;
			const startY = e.clientY;
			const start = this.project(marker.coords)!;
			let dragging = false;
			let moved = false;
			body.setPointerCapture(e.pointerId);

			const onMove = (ev: PointerEvent) => {
				const dx = ev.clientX - startX;
				const dy = ev.clientY - startY;
				if (!dragging && Math.hypot(dx, dy) < 4) return;
				// закреплённую метку не двигаем, а потянутую — не считаем кликом
				if (marker.locked || this.plugin.settings.markersLocked) {
					moved = true;
					return;
				}
				if (!dragging) {
					dragging = true;
					pinEl.addClass("is-dragging");
				}
				marker.coords = this.unproject(start[0] + dx, start[1] + dy);
				this.updatePositions();
			};
			const onUp = () => {
				body.removeEventListener("pointermove", onMove);
				body.removeEventListener("pointerup", onUp);
				body.removeEventListener("pointercancel", onUp);
				pinEl.removeClass("is-dragging");
				if (dragging) {
					this.plugin.save(false);
				} else if (!moved) {
					this.plugin.updateMarker(marker.id, { cardOpen: !marker.cardOpen });
					if (marker.cardOpen) this.bringToFront(marker.id);
				}
			};
			body.addEventListener("pointermove", onMove);
			body.addEventListener("pointerup", onUp);
			body.addEventListener("pointercancel", onUp);
		});
		body.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const marker = this.plugin.getMarker(m.id);
			if (marker) this.showMarkerMenu(marker, e);
		});
		return { pinEl, labelEl };
	}

	pulse(id: string) {
		const ui = this.ui.get(id);
		if (!ui) return;
		ui.pinEl.removeClass("is-pulse");
		void ui.pinEl.offsetWidth; // перезапуск CSS-анимации
		ui.pinEl.addClass("is-pulse");
		window.setTimeout(() => ui.pinEl.removeClass("is-pulse"), 1400);
	}

	// ---------------- карточки ----------------

	private createCard(m: MapMarker): CardUI {
		const el = this.cardsEl.createDiv("gis-card");
		el.style.zIndex = String(++this.zTop);
		el.style.width = `${m.cardSize[0]}px`;
		el.style.height = `${m.cardSize[1]}px`;

		const header = el.createDiv("gis-card-header");
		header.createDiv("gis-card-color");
		const titleEl = header.createDiv("gis-card-title");
		const actions = header.createDiv("gis-card-actions");
		const openBtn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Открыть заметку" } });
		setIcon(openBtn, "file-symlink");
		const menuBtn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Ещё" } });
		setIcon(menuBtn, "more-horizontal");
		const closeBtn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Свернуть" } });
		setIcon(closeBtn, "x");

		const bodyEl = el.createDiv("gis-card-body markdown-rendered");

		const lineEl = document.createElementNS(SVG_NS, "line");
		lineEl.classList.add("gis-line");
		const dotEl = document.createElementNS(SVG_NS, "circle");
		dotEl.classList.add("gis-line-dot");
		dotEl.setAttribute("r", "4");
		this.svgEl.append(lineEl, dotEl);

		const component = new Component();
		component.load();

		const id = m.id;
		openBtn.onclick = (e) => {
			const marker = this.plugin.getMarker(id);
			if (marker?.notePath) this.app.workspace.openLinkText(marker.notePath, "", e.ctrlKey || e.metaKey ? "tab" : true);
		};
		menuBtn.onclick = (e) => {
			const marker = this.plugin.getMarker(id);
			if (marker) this.showMarkerMenu(marker, e);
		};
		closeBtn.onclick = () => this.plugin.updateMarker(id, { cardOpen: false });
		titleEl.ondblclick = () => this.renameMarker(id);

		el.addEventListener("pointerdown", () => this.bringToFront(id));
		el.addEventListener("wheel", (e) => e.stopPropagation());

		// перетаскивание карточки за заголовок
		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target as HTMLElement).closest(".clickable-icon")) return;
			const marker = this.plugin.getMarker(id);
			if (!marker) return;
			e.preventDefault();
			header.setPointerCapture(e.pointerId);
			const sx = e.clientX;
			const sy = e.clientY;
			const [ox, oy] = marker.cardOffset;
			el.addClass("is-dragging");
			const onMove = (ev: PointerEvent) => {
				marker.cardOffset = [ox + ev.clientX - sx, oy + ev.clientY - sy];
				this.updatePositions();
			};
			const onUp = () => {
				header.removeEventListener("pointermove", onMove);
				header.removeEventListener("pointerup", onUp);
				header.removeEventListener("pointercancel", onUp);
				el.removeClass("is-dragging");
				this.plugin.save(false);
			};
			header.addEventListener("pointermove", onMove);
			header.addEventListener("pointerup", onUp);
			header.addEventListener("pointercancel", onUp);
		});

		// изменение размера (CSS resize) — запоминаем размер и перерисовываем линию
		const resizeObserver = new ResizeObserver(() => {
			const marker = this.plugin.getMarker(id);
			if (!marker || !el.isConnected) return;
			const size: [number, number] = [el.offsetWidth, el.offsetHeight];
			if (size[0] === 0) return;
			if (size[0] !== marker.cardSize[0] || size[1] !== marker.cardSize[1]) {
				marker.cardSize = size;
				this.plugin.save(false);
				this.updatePositions();
			}
		});
		resizeObserver.observe(el);

		// внутренние ссылки в отрендеренной заметке
		bodyEl.addEventListener("click", (e) => {
			const a = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
			if (!a) return;
			e.preventDefault();
			const marker = this.plugin.getMarker(id);
			const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
			this.app.workspace.openLinkText(href, marker?.notePath ?? "", e.ctrlKey || e.metaKey ? "tab" : true);
		});

		requestAnimationFrame(() => el.addClass("is-shown"));
		return { el, titleEl, bodyEl, lineEl, dotEl, component, renderedPath: null, resizeObserver };
	}

	private removeCard(ui: MarkerUI) {
		const card = ui.card;
		if (!card) return;
		card.component.unload();
		card.resizeObserver.disconnect();
		card.lineEl.remove();
		card.dotEl.remove();
		card.el.remove();
		ui.card = undefined;
	}

	private updateCard(m: MapMarker, card: CardUI) {
		card.el.style.setProperty("--pin-color", m.color);
		card.lineEl.style.stroke = m.color;
		card.dotEl.style.fill = m.color;
		card.titleEl.setText(m.name);
		card.titleEl.setAttr("title", m.notePath || m.name);
		if (card.el.offsetWidth !== m.cardSize[0] || card.el.offsetHeight !== m.cardSize[1]) {
			card.el.style.width = `${m.cardSize[0]}px`;
			card.el.style.height = `${m.cardSize[1]}px`;
		}
		if (card.renderedPath !== m.notePath) this.renderCardBody(m, card);
	}

	private async renderCardBody(m: MapMarker, card: CardUI) {
		card.renderedPath = m.notePath;
		card.component.unload();
		card.component = new Component();
		card.component.load();
		card.bodyEl.empty();

		const file = m.notePath ? this.app.vault.getAbstractFileByPath(m.notePath) : null;
		if (!(file instanceof TFile)) {
			const empty = card.bodyEl.createDiv("gis-card-empty");
			empty.createDiv({ text: m.notePath ? `Заметка «${m.notePath}» не найдена` : "К метке не привязана заметка" });
			const btn = empty.createEl("button", { text: "Привязать заметку" });
			btn.onclick = () => this.linkNote(m.id);
			return;
		}
		const raw = await this.app.vault.cachedRead(file);
		const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		if (card.renderedPath !== m.notePath) return; // успели сменить заметку
		card.bodyEl.empty();
		await MarkdownRenderer.render(this.app, content, card.bodyEl, file.path, card.component);
	}

	private onNoteModified(path: string) {
		for (const m of this.plugin.data.markers) {
			if (m.notePath !== path) continue;
			const card = this.ui.get(m.id)?.card;
			if (card) this.renderCardBody(m, card);
		}
	}

	bringToFront(id: string) {
		const card = this.ui.get(id)?.card;
		if (card) card.el.style.zIndex = String(++this.zTop);
	}

	// ---------------- меню и действия с меткой ----------------

	showMarkerMenu(m: MapMarker, evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(m.cardOpen ? "Свернуть карточку" : "Открыть карточку").setIcon("panel-top")
			.onClick(() => this.plugin.updateMarker(m.id, { cardOpen: !m.cardOpen })));
		menu.addItem((i) => i.setTitle(m.hidden ? "Показывать на карте" : "Скрыть с карты").setIcon(m.hidden ? "eye" : "eye-off")
			.onClick(() => this.plugin.updateMarker(m.id, { hidden: !m.hidden })));
		menu.addItem((i) => i.setTitle("Перейти к метке").setIcon("locate-fixed")
			.onClick(() => this.flyTo(m.id)));
		if (m.notePath) {
			menu.addItem((i) => i.setTitle("Открыть заметку").setIcon("file-symlink")
				.onClick(() => this.app.workspace.openLinkText(m.notePath, "", true)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Переименовать").setIcon("pencil").onClick(() => this.renameMarker(m.id)));
		menu.addItem((i) => i.setTitle(m.notePath ? "Сменить заметку" : "Привязать заметку").setIcon("link")
			.onClick(() => this.linkNote(m.id)));
		menu.addItem((i) => i.setTitle(m.locked ? "Открепить (разрешить перетаскивание)" : "Закрепить на месте")
			.setIcon(m.locked ? "unlock" : "lock")
			.onClick(() => this.plugin.updateMarker(m.id, { locked: !m.locked })));
		menu.addItem((i) => i.setTitle("Связать с меткой…").setIcon("route").onClick(() => this.startLink(m.id)));
		menu.addItem((i) => i.setTitle("Цвет…").setIcon("palette").onClick(() =>
			new ColorModal(this.app, m.color, (color) => this.plugin.updateMarker(m.id, { color })).open()));
		menu.addItem((i) => i.setTitle("Переместить в папку…").setIcon("folder-input")
			.onClick(() => this.showMoveMenu(m, evt)));
		menu.addItem((i) => i.setTitle("Сбросить положение карточки").setIcon("rotate-ccw")
			.onClick(() => this.plugin.updateMarker(m.id, { cardOffset: [...DEFAULT_CARD_OFFSET], cardSize: [...DEFAULT_CARD_SIZE] })));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Удалить метку").setIcon("trash-2").setWarning(true)
			.onClick(() => new ConfirmModal(this.app, `Удалить метку «${m.name}»? Заметка останется.`,
				() => this.plugin.deleteMarker(m.id)).open()));
		menu.showAtMouseEvent(evt);
	}

	private showMoveMenu(m: MapMarker, evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("— Без папки —").setChecked(m.folderId === null)
			.onClick(() => this.plugin.updateMarker(m.id, { folderId: null })));
		for (const { folder, path } of this.sidebar.flatFolders()) {
			menu.addItem((i) => i.setTitle(path).setIcon("folder").setChecked(m.folderId === folder.id)
				.onClick(() => this.plugin.updateMarker(m.id, { folderId: folder.id })));
		}
		menu.showAtMouseEvent(evt);
	}

	renameMarker(id: string) {
		const m = this.plugin.getMarker(id);
		if (!m) return;
		new PromptModal(this.app, "Название метки", m.name, (name) => this.plugin.updateMarker(id, { name })).open();
	}

	linkNote(id: string) {
		new NotePickerModal(this.app, async (choice, query) => {
			const m = this.plugin.getMarker(id);
			if (!m) return;
			if (choice.kind === "file") {
				this.plugin.updateMarker(id, { notePath: choice.file.path });
			} else if (choice.kind === "new") {
				const file = await this.createNote(query || m.name, m.coords);
				if (file) this.plugin.updateMarker(id, { notePath: file.path });
			} else {
				this.plugin.updateMarker(id, { notePath: "" });
			}
		}).open();
	}

	// ---------------- связи между метками ----------------

	private syncLinks() {
		// связь видна, только если на карте видны обе её метки
		const links = this.plugin.data.links.filter((l) => this.ui.has(l.from) && this.ui.has(l.to));
		const alive = new Set(links.map((l) => l.id));
		for (const [id, ui] of [...this.linkUI]) {
			if (alive.has(id)) continue;
			ui.g.remove();
			this.linkUI.delete(id);
		}
		for (const l of links) {
			let ui = this.linkUI.get(l.id);
			if (!ui) {
				ui = this.createLink(l.id);
				this.linkUI.set(l.id, ui);
			}
			ui.g.style.setProperty("--link-color", l.color);
			ui.labelEl.textContent = l.label;
			ui.labelEl.style.display = l.label ? "" : "none";
		}
	}

	private createLink(id: string): LinkUI {
		const g = svgEl("g", "gis-link");
		const lineEl = svgEl("line", "gis-link-line");
		const arrowStartEl = svgEl("polygon", "gis-link-arrow");
		const arrowEndEl = svgEl("polygon", "gis-link-arrow");
		// широкая прозрачная линия — чтобы по связи было легко попасть мышью
		const hitEl = svgEl("line", "gis-link-hit");
		const labelEl = svgEl("text", "gis-link-label");
		g.append(lineEl, arrowStartEl, arrowEndEl, hitEl, labelEl);
		this.linksEl.appendChild(g);

		const onMenu = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const link = this.plugin.getLink(id);
			if (link) this.showLinkMenu(link, e);
		};
		for (const el of [hitEl, labelEl]) {
			el.addEventListener("click", onMenu);
			el.addEventListener("contextmenu", onMenu);
		}
		return { g, hitEl, lineEl, arrowStartEl, arrowEndEl, labelEl };
	}

	private updateLinkPositions() {
		if (!this.map || !this.linkUI.size) return;
		const markers = new Map(this.plugin.data.markers.map((m) => [m.id, m]));
		for (const l of this.plugin.data.links) {
			const ui = this.linkUI.get(l.id);
			if (!ui) continue;
			const a = markers.get(l.from);
			const b = markers.get(l.to);
			const pa = a && this.project(a.coords);
			const pb = b && this.project(b.coords);
			const ax = pa?.[0] ?? 0;
			const ay = (pa?.[1] ?? 0) - PIN_HEAD_Y;
			const bx = pb?.[0] ?? 0;
			const by = (pb?.[1] ?? 0) - PIN_HEAD_Y;
			const len = Math.hypot(bx - ax, by - ay);
			// метки почти совпадают — линию не рисуем
			if (!pa || !pb || len < LINK_GAP * 2 + ARROW_LEN) {
				ui.g.style.display = "none";
				continue;
			}
			ui.g.style.display = "";
			const ux = (bx - ax) / len;
			const uy = (by - ay) / len;
			// концы линии — у края «головок» меток
			const x1 = ax + ux * LINK_GAP;
			const y1 = ay + uy * LINK_GAP;
			const x2 = bx - ux * LINK_GAP;
			const y2 = by - uy * LINK_GAP;
			const atStart = l.direction === "backward" || l.direction === "both";
			const atEnd = l.direction === "forward" || l.direction === "both";
			// пунктир заканчивается у основания стрелки
			const inset = ARROW_LEN - 2;
			setLine(ui.lineEl, x1 + (atStart ? ux * inset : 0), y1 + (atStart ? uy * inset : 0),
				x2 - (atEnd ? ux * inset : 0), y2 - (atEnd ? uy * inset : 0));
			setLine(ui.hitEl, x1, y1, x2, y2);
			setArrow(ui.arrowStartEl, atStart, x1, y1, -ux, -uy);
			setArrow(ui.arrowEndEl, atEnd, x2, y2, ux, uy);

			if (l.label) {
				// надпись над серединой линии, всегда читается слева направо
				let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
				if (angle > 90) angle -= 180;
				else if (angle < -90) angle += 180;
				ui.labelEl.setAttribute("transform", `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2}) rotate(${angle}) translate(0 -7)`);
			}
		}
	}

	/** Режим создания связи: следующий клик по метке соединяет её с from */
	startLink(fromId: string) {
		const from = this.plugin.getMarker(fromId);
		if (!from || !this.map) return;
		if (this.addMode) this.setAddMode(false);
		this.cancelLink();
		this.linkFrom = fromId;
		this.wrapEl.addClass("is-linking");
		this.linkDraftEl = svgEl("line", "gis-link-draft");
		this.linkDraftEl.style.setProperty("--link-color", from.color);
		this.svgEl.appendChild(this.linkDraftEl);
		this.updateLinkDraft();
		new Notice(`Кликните по метке, которую нужно связать с «${from.name}». Esc — отмена.`, 3000);
	}

	private updateLinkDraft() {
		const draft = this.linkDraftEl;
		const from = this.linkFrom ? this.plugin.getMarker(this.linkFrom) : null;
		if (!draft || !from) return;
		const p = this.project(from.coords);
		if (!p || !this.pointer) {
			draft.style.display = "none";
			return;
		}
		draft.style.display = "";
		setLine(draft, p[0], p[1] - PIN_HEAD_Y, this.pointer[0], this.pointer[1]);
	}

	private cancelLink() {
		this.linkFrom = null;
		this.linkDraftEl?.remove();
		this.linkDraftEl = null;
		this.wrapEl.removeClass("is-linking");
	}

	private finishLink(toId: string) {
		const fromId = this.linkFrom;
		this.cancelLink();
		const from = fromId ? this.plugin.getMarker(fromId) : null;
		if (!from) return;
		if (fromId === toId) {
			new Notice("Нельзя связать метку саму с собой");
			return;
		}
		if (this.plugin.findLink(from.id, toId)) {
			new Notice("Эти метки уже связаны");
			return;
		}
		this.plugin.addLink(from.id, toId, from.color);
	}

	showLinkMenu(l: MarkerLink, evt: MouseEvent) {
		const nameA = this.plugin.getMarker(l.from)?.name ?? "?";
		const nameB = this.plugin.getMarker(l.to)?.name ?? "?";
		const menu = new Menu();
		const dirs: [LinkDirection, string, string][] = [
			["forward", `Стрелка к «${nameB}»`, "arrow-right"],
			["backward", `Стрелка к «${nameA}»`, "arrow-left"],
			["both", "Стрелки в обе стороны", "arrow-left-right"],
			["none", "Без стрелок", "minus"],
		];
		for (const [dir, title, icon] of dirs) {
			menu.addItem((i) => i.setTitle(title).setIcon(icon).setChecked(l.direction === dir)
				.onClick(() => this.plugin.updateLink(l.id, { direction: dir })));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(l.label ? "Изменить надпись…" : "Добавить надпись…").setIcon("type")
			.onClick(() => new PromptModal(this.app, "Надпись на линии", l.label,
				(label) => this.plugin.updateLink(l.id, { label }), true).open()));
		menu.addItem((i) => i.setTitle("Цвет…").setIcon("palette").onClick(() =>
			new ColorModal(this.app, l.color, (color) => this.plugin.updateLink(l.id, { color }), "Цвет линии").open()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(`Перейти к «${nameA}»`).setIcon("locate-fixed").onClick(() => this.flyTo(l.from)));
		menu.addItem((i) => i.setTitle(`Перейти к «${nameB}»`).setIcon("locate-fixed").onClick(() => this.flyTo(l.to)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Удалить связь").setIcon("trash-2").setWarning(true)
			.onClick(() => this.plugin.deleteLink(l.id)));
		menu.showAtMouseEvent(evt);
	}

	// ---------------- плавный перелёт ----------------

	/**
	 * Перелёт камеры к метке по сглаженной траектории MapLibre (отдаление — пролёт — приближение).
	 * Длительность зависит от длины пути на экране: скорость камеры не выше flySpeed экранов в секунду,
	 * поэтому дальние перелёты идут дольше, а ближние — не короче flyDuration.
	 */
	flyTo(id: string) {
		const map = this.map;
		const m = this.plugin.getMarker(id);
		if (!map || !m) return;
		map.stop();
		const visible = this.plugin.isMarkerVisible(m);
		if (!visible) new Notice(m.hidden ? "Метка скрыта с карты" : "Метка в скрытой папке", 2000);

		const s = this.plugin.settings;
		const w = this.wrapEl.clientWidth;
		const h = this.wrapEl.clientHeight;
		const z0 = map.getZoom();
		const z1 = Math.max(z0, s.flyZoom);
		// пикселей на единицу меркатора при текущем масштабе
		const a = toMerc(this.unproject(0, h / 2));
		const b = toMerc(this.unproject(100, h / 2));
		const ppm0 = 100 / Math.max(1e-12, Math.abs(b[0] - a[0]));

		// метка оказывается в центре видимой части карты (без области под боковой панелью);
		// центр сдвигаем сами — padding в flyTo остался бы у карты навсегда
		const ppm1 = ppm0 * Math.pow(2, z1 - z0);
		const visibleCenterX = (w - this.sidebar.coveredWidth) / 2;
		const mm = toMerc(m.coords);
		const c1: [number, number] = [mm[0] + (w / 2 - visibleCenterX) / ppm1, mm[1]];
		const c0 = toMerc(map.getCenter().toArray());
		const center = fromMerc(c1);

		const screens = flyPathScreens(Math.max(w, h), z1 - z0, Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) * ppm0);
		const duration = Math.min(FLY_MAX_DURATION, Math.max(s.flyDuration, (screens / s.flySpeed) * 1000));

		const token = ++this.flyToken;
		map.flyTo({ center, zoom: z1, curve: FLY_CURVE, duration, essential: true });
		map.once("moveend", () => {
			// перелёт прервали (пользователь потянул карту или начался новый) — карточку не открываем
			if (token !== this.flyToken || !visible) return;
			const p = map.project(center);
			if (Math.hypot(p.x - w / 2, p.y - h / 2) > 10) return;
			if (s.openCardOnFly && !m.cardOpen) this.plugin.updateMarker(m.id, { cardOpen: true });
			this.bringToFront(m.id);
			this.pulse(m.id);
		});
	}
}

function setLine(el: SVGLineElement, x1: number, y1: number, x2: number, y2: number) {
	el.setAttribute("x1", String(x1));
	el.setAttribute("y1", String(y1));
	el.setAttribute("x2", String(x2));
	el.setAttribute("y2", String(y2));
}

/** Треугольная стрелка с вершиной в (x, y), направленная по (ux, uy) */
function setArrow(el: SVGPolygonElement, show: boolean, x: number, y: number, ux: number, uy: number) {
	el.style.display = show ? "" : "none";
	if (!show) return;
	const bx = x - ux * ARROW_LEN;
	const by = y - uy * ARROW_LEN;
	const px = -uy * ARROW_HALF_W;
	const py = ux * ARROW_HALF_W;
	el.setAttribute("points", `${x},${y} ${bx + px},${by + py} ${bx - px},${by - py}`);
}
