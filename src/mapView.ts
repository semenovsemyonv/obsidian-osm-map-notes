import {
	Component, ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon,
} from "obsidian";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import type MapNotesPlugin from "./main";
import { DEFAULT_CARD_OFFSET, DEFAULT_CARD_SIZE, MapMarker } from "./types";
import { easeInOutCubic, fromMerc, rectEdgePoint, toMerc } from "./geo";
import { ColorModal, ConfirmModal, NotePickerModal, PromptModal } from "./modals";
import { Sidebar } from "./sidebar";
import { DownloadJob, OFFLINE_PROTOCOL } from "./offline";
import { OfflineModal } from "./offlineModal";
import { loadVectorStyle } from "./vectorStyle";

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

interface MarkerUI {
	pinEl: HTMLElement;
	labelEl: HTMLElement;
	card?: CardUI;
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
	private pinsEl!: HTMLElement;
	private cardsEl!: HTMLElement;
	private addBtn!: HTMLElement;
	private modeBtn!: HTMLElement;
	private navControl: maplibregl.NavigationControl | null = null;
	private sidebar!: Sidebar;

	private ui = new Map<string, MarkerUI>();
	private addMode = false;
	private zTop = 10;
	private flyRaf = 0;
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
		this.pinsEl = this.overlayEl.createDiv("gis-pins");
		this.cardsEl = this.overlayEl.createDiv("gis-cards");

		this.buildToolbar();
		this.sidebar = new Sidebar(this, root);
		this.sidebar.setOpen(this.plugin.settings.sidebarOpen, false);

		this.registerEvent(this.plugin.events.on("changed", () => this.sync()));
		this.registerEvent(this.plugin.events.on("note-modified", (path: string) => this.onNoteModified(path)));
		this.registerDomEvent(root, "keydown", (e) => {
			if (e.key === "Escape" && this.addMode) this.setAddMode(false);
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
		cancelAnimationFrame(this.flyRaf);
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
		this.addMode = on;
		this.addBtn.toggleClass("is-active", on);
		this.wrapEl.toggleClass("is-adding", on);
		if (on) new Notice("Кликните по карте, чтобы поставить метку. Esc — отмена.", 2500);
	}

	toggleSidebar() {
		this.sidebar.setOpen(!this.sidebar.isOpen);
	}

	// ---------------- добавление меток ----------------

	startAddMarker(coords: [number, number], folderId: string | null = null) {
		new NotePickerModal(this.app, async (choice, query) => {
			if (choice.kind === "file") {
				this.plugin.addMarker(coords, choice.file.basename, choice.file.path, folderId);
			} else if (choice.kind === "new") {
				const name = query || "Новая метка";
				const file = await this.createNote(name, coords);
				this.plugin.addMarker(coords, name, file?.path ?? "", folderId);
			} else {
				this.plugin.addMarker(coords, query || "Метка", "", folderId);
			}
		}).open();
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

				if (m.cardOpen && !ui.card) ui.card = this.createCard(m);
				if (!m.cardOpen && ui.card) this.removeCard(ui);
				if (ui.card) this.updateCard(m, ui.card);
			}
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
			const headY = y - 17; // центр «головки» метки
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
			const marker = this.plugin.getMarker(m.id);
			if (!marker) return;
			const startX = e.clientX;
			const startY = e.clientY;
			const start = this.project(marker.coords)!;
			let dragging = false;
			body.setPointerCapture(e.pointerId);

			const onMove = (ev: PointerEvent) => {
				const dx = ev.clientX - startX;
				const dy = ev.clientY - startY;
				if (!dragging && Math.hypot(dx, dy) < 4) return;
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
				} else {
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

	// ---------------- плавный перелёт ----------------

	/**
	 * Перелёт камеры к метке: центр интерполируется в меркаторе,
	 * а масштаб «проседает» посередине пути, если цель далеко (эффект flyTo).
	 */
	flyTo(id: string) {
		const map = this.map;
		const m = this.plugin.getMarker(id);
		if (!map || !m) return;
		cancelAnimationFrame(this.flyRaf);
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

		// метка оказывается в центре видимой части карты (без области под боковой панелью)
		const ppm1 = ppm0 * Math.pow(2, z1 - z0);
		const visibleCenterX = (w - this.sidebar.coveredWidth) / 2;
		const mm = toMerc(m.coords);
		const c1: [number, number] = [mm[0] + (w / 2 - visibleCenterX) / ppm1, mm[1]];
		const c0 = toMerc(map.getCenter().toArray());

		// насколько отдалиться в середине пути
		const zMin = Math.min(z0, z1);
		const distPx = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) * ppm0 * Math.pow(2, zMin - z0);
		const need = Math.log2(distPx / (Math.max(w, h) * 0.7));
		const zPeak = Math.max(2, zMin - Math.max(0, need));
		const dip = Math.max(0, (z0 + z1) / 2 - zPeak);

		const duration = s.flyDuration;
		const t0 = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / duration);
			const e = easeInOutCubic(t);
			const zoom = z0 + (z1 - z0) * e - dip * Math.sin(Math.PI * e);
			const center = fromMerc([c0[0] + (c1[0] - c0[0]) * e, c0[1] + (c1[1] - c0[1]) * e]);
			map.jumpTo({ center, zoom });
			if (t < 1) {
				this.flyRaf = requestAnimationFrame(step);
			} else {
				this.flyRaf = 0;
				if (!visible) return;
				if (s.openCardOnFly && !m.cardOpen) this.plugin.updateMarker(m.id, { cardOpen: true });
				this.bringToFront(m.id);
				this.pulse(m.id);
			}
		};
		this.flyRaf = requestAnimationFrame(step);
	}
}
