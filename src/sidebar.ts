import { Menu, getIcon, setIcon } from "obsidian";
import type { MapView } from "./mapView";
import type { MapMarker, MarkerFolder } from "./types";
import { ConfirmModal, PromptModal } from "./modals";

const DRAG_MIME = "application/x-gis-map-item";

type DragItem = { type: "marker" | "folder"; id: string };

/** Выезжающая справа панель со списком меток и папками */
export class Sidebar {
	isOpen = true;
	private el: HTMLElement;
	private treeEl: HTMLElement;
	private countEl: HTMLElement;
	private showAllBtn: HTMLElement;
	private lockBtn: HTMLElement;
	private searchEl: HTMLInputElement;
	private query = "";

	constructor(private view: MapView, parent: HTMLElement) {
		this.el = parent.createDiv("gis-sidebar");

		const handle = this.el.createDiv({ cls: "gis-sidebar-handle", attr: { "aria-label": "Список меток" } });
		setIcon(handle, "list");
		handle.onclick = () => this.setOpen(!this.isOpen);

		// замок слева от ручки списка: запрет перетаскивания всех меток
		this.lockBtn = this.el.createDiv("gis-sidebar-handle gis-lock-handle");
		this.lockBtn.onclick = () => {
			const s = this.view.plugin.settings;
			s.markersLocked = !s.markersLocked;
			this.view.plugin.save(false);
			this.updateLockBtn();
		};
		this.updateLockBtn();

		const panel = this.el.createDiv("gis-sidebar-panel");
		const header = panel.createDiv("gis-sidebar-header");
		const title = header.createDiv("gis-sidebar-title");
		title.createSpan({ text: "Метки" });
		this.countEl = title.createSpan("gis-sidebar-count");

		this.showAllBtn = header.createDiv({ cls: "clickable-icon gis-show-all", attr: { "aria-label": "Показать все скрытые метки" } });
		setIcon(this.showAllBtn, "eye");
		this.showAllBtn.onclick = () => this.view.plugin.showAll();
		const newFolder = header.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Новая папка" } });
		setIcon(newFolder, "folder-plus");
		newFolder.onclick = () => this.createFolder(null);
		const hide = header.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Скрыть панель" } });
		setIcon(hide, "panel-right-close");
		hide.onclick = () => this.setOpen(false);

		this.searchEl = panel.createEl("input", {
			cls: "gis-sidebar-search",
			attr: { type: "search", placeholder: "Поиск меток…" },
		});
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value.trim().toLowerCase();
			this.render();
		});

		this.treeEl = panel.createDiv("gis-tree");
		// бросить в пустое место — переместить в корень
		this.setupDropTarget(this.treeEl, null);
		this.treeEl.addEventListener("contextmenu", (e) => {
			if (e.target !== this.treeEl) return;
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Новая папка").setIcon("folder-plus").onClick(() => this.createFolder(null)));
			menu.addItem((i) => i.setTitle("Показать все скрытые метки").setIcon("eye").onClick(() => this.view.plugin.showAll()));
			menu.showAtMouseEvent(e);
		});
	}

	private updateLockBtn() {
		const locked = this.view.plugin.settings.markersLocked;
		this.lockBtn.empty();
		// в старых версиях Obsidian иконка открытого замка называется «unlock»
		setIcon(this.lockBtn, locked ? "lock" : getIcon("lock-open") ? "lock-open" : "unlock");
		this.lockBtn.setAttr("aria-label", locked
			? "Метки закреплены — нажмите, чтобы разрешить перетаскивание"
			: "Закрепить все метки (запретить перетаскивание)");
	}

	/** Сколько пикселей карты закрывает панель справа */
	get coveredWidth(): number {
		return this.isOpen ? this.el.offsetWidth : 0;
	}

	setOpen(open: boolean, persist = true) {
		this.isOpen = open;
		this.el.toggleClass("is-open", open);
		// по этому классу тулбар карты освобождает место под открытую панель
		this.view.contentEl.toggleClass("gis-sidebar-open", open);
		if (persist) {
			this.view.plugin.settings.sidebarOpen = open;
			this.view.plugin.save(false);
		}
	}

	/** Папки в порядке дерева с полными путями — для меню «Переместить в папку» */
	flatFolders(): { folder: MarkerFolder; path: string }[] {
		const out: { folder: MarkerFolder; path: string }[] = [];
		const walk = (parentId: string | null, prefix: string) => {
			for (const f of this.childFolders(parentId)) {
				const path = prefix ? `${prefix} / ${f.name}` : f.name;
				out.push({ folder: f, path });
				walk(f.id, path);
			}
		};
		walk(null, "");
		return out;
	}

	private childFolders(parentId: string | null): MarkerFolder[] {
		return this.view.plugin.data.folders
			.filter((f) => f.parentId === parentId)
			.sort((a, b) => a.name.localeCompare(b.name, "ru"));
	}

	private childMarkers(folderId: string | null): MapMarker[] {
		return this.view.plugin.data.markers
			.filter((m) => m.folderId === folderId && this.matches(m))
			.sort((a, b) => a.name.localeCompare(b.name, "ru"));
	}

	private matches(m: MapMarker): boolean {
		if (!this.query) return true;
		return m.name.toLowerCase().includes(this.query) || m.notePath.toLowerCase().includes(this.query);
	}

	/** Число подходящих меток в папке вместе с вложенными */
	private countIn(folderId: string): number {
		let n = this.childMarkers(folderId).length;
		for (const f of this.childFolders(folderId)) n += this.countIn(f.id);
		return n;
	}

	render() {
		const { markers, folders } = this.view.plugin.data;
		const visible = markers.filter((m) => this.view.plugin.isMarkerVisible(m)).length;
		this.countEl.setText(visible === markers.length ? String(markers.length) : `${visible} / ${markers.length}`);
		this.countEl.setAttr("aria-label", visible === markers.length ? "Меток" : "Видно на карте / всего");
		this.showAllBtn.toggle(markers.some((m) => m.hidden) || folders.some((f) => f.hidden));
		this.treeEl.empty();
		this.renderLevel(this.treeEl, null, 0);

		if (!this.treeEl.hasChildNodes()) {
			this.treeEl.createDiv({
				cls: "gis-tree-empty",
				text: this.query
					? "Ничего не найдено"
					: "Меток пока нет. Нажмите «Метка» и кликните по карте, или перетащите заметку на карту.",
			});
		}
	}

	private renderLevel(container: HTMLElement, parentId: string | null, depth: number) {
		for (const folder of this.childFolders(parentId)) {
			const count = this.countIn(folder.id);
			if (this.query && count === 0) continue;
			this.renderFolder(container, folder, depth, count);
		}
		for (const m of this.childMarkers(parentId)) this.renderMarker(container, m, depth);
	}

	private renderFolder(container: HTMLElement, folder: MarkerFolder, depth: number, count: number) {
		const collapsed = folder.collapsed && !this.query;
		const wrap = container.createDiv("gis-tree-folder");
		const row = wrap.createDiv({ cls: "gis-tree-row is-folder" });
		row.style.paddingLeft = `${8 + depth * 16}px`;
		row.draggable = true;

		const chevron = row.createDiv("gis-tree-chevron");
		setIcon(chevron, "chevron-right");
		chevron.toggleClass("is-collapsed", collapsed);
		const icon = row.createDiv("gis-tree-icon");
		setIcon(icon, collapsed ? "folder" : "folder-open");
		row.createDiv({ cls: "gis-tree-name", text: folder.name });
		row.createDiv({ cls: "gis-tree-badge", text: String(count) });
		const plugin = this.view.plugin;
		this.addEyeButton(row, !!folder.hidden, plugin.isFolderHidden(folder.parentId),
			() => plugin.updateFolder(folder.id, { hidden: !folder.hidden }));

		row.onclick = () => plugin.updateFolder(folder.id, { collapsed: !folder.collapsed });
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showFolderMenu(folder, e);
		});
		this.setupDragSource(row, { type: "folder", id: folder.id });
		this.setupDropTarget(row, folder.id);

		const children = wrap.createDiv("gis-tree-children");
		if (collapsed) children.addClass("is-collapsed");
		else this.renderLevel(children, folder.id, depth + 1);
	}

	private renderMarker(container: HTMLElement, m: MapMarker, depth: number) {
		const row = container.createDiv({ cls: "gis-tree-row is-marker" });
		row.style.paddingLeft = `${8 + depth * 16 + 18}px`;
		row.draggable = true;
		const dot = row.createDiv("gis-tree-dot");
		dot.style.background = m.color;
		const text = row.createDiv("gis-tree-text");
		text.createDiv({ cls: "gis-tree-name", text: m.name });
		if (m.notePath) text.createDiv({ cls: "gis-tree-sub", text: m.notePath.replace(/\.md$/, "") });
		if (m.cardOpen) row.addClass("has-card");
		const plugin = this.view.plugin;
		this.addEyeButton(row, !!m.hidden, plugin.isFolderHidden(m.folderId),
			() => plugin.updateMarker(m.id, { hidden: !m.hidden }));

		row.onclick = () => {
			this.treeEl.findAll(".is-selected").forEach((x) => x.removeClass("is-selected"));
			row.addClass("is-selected");
			this.view.flyTo(m.id);
		};
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.view.showMarkerMenu(m, e);
		});
		this.setupDragSource(row, { type: "marker", id: m.id });
	}

	/**
	 * Глаз справа в строке: скрыть/показать на карте.
	 * inheritedHidden — элемент скрыт через родительскую папку (строка тускнеет, глаз остаётся рабочим).
	 */
	private addEyeButton(row: HTMLElement, hidden: boolean, inheritedHidden: boolean, toggle: () => void) {
		row.toggleClass("is-hidden", hidden || inheritedHidden);
		const eye = row.createDiv({
			cls: "gis-tree-eye clickable-icon" + (hidden ? " is-off" : ""),
			attr: { "aria-label": hidden ? "Показывать на карте" : "Скрыть с карты" },
		});
		setIcon(eye, hidden ? "eye-off" : "eye");
		eye.addEventListener("click", (e) => {
			e.stopPropagation();
			toggle();
		});
	}

	private showFolderMenu(folder: MarkerFolder, e: MouseEvent) {
		const plugin = this.view.plugin;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(folder.hidden ? "Показывать на карте" : "Скрыть с карты")
			.setIcon(folder.hidden ? "eye" : "eye-off")
			.onClick(() => plugin.updateFolder(folder.id, { hidden: !folder.hidden })));
		menu.addItem((i) => i.setTitle("Новая подпапка").setIcon("folder-plus").onClick(() => this.createFolder(folder.id)));
		menu.addItem((i) => i.setTitle("Переименовать").setIcon("pencil").onClick(() =>
			new PromptModal(this.view.app, "Название папки", folder.name,
				(name) => plugin.updateFolder(folder.id, { name })).open()));
		menu.addItem((i) => i.setTitle("Открыть все карточки").setIcon("panel-top").onClick(() => this.setCardsInFolder(folder.id, true)));
		menu.addItem((i) => i.setTitle("Свернуть все карточки").setIcon("panel-top-close").onClick(() => this.setCardsInFolder(folder.id, false)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Удалить папку").setIcon("trash-2").setWarning(true).onClick(() =>
			new ConfirmModal(this.view.app, `Удалить папку «${folder.name}»? Метки из неё переместятся на уровень выше.`,
				() => plugin.deleteFolder(folder.id)).open()));
		menu.showAtMouseEvent(e);
	}

	private setCardsInFolder(folderId: string, open: boolean) {
		const plugin = this.view.plugin;
		for (const m of plugin.data.markers) {
			if (plugin.isFolderInside(m.folderId, folderId)) m.cardOpen = open;
		}
		plugin.save();
	}

	private createFolder(parentId: string | null) {
		new PromptModal(this.view.app, "Новая папка", "Новая папка", (name) => {
			this.view.plugin.addFolder(name, parentId);
			if (parentId) this.view.plugin.updateFolder(parentId, { collapsed: false });
		}).open();
	}

	// ---------------- drag & drop ----------------

	private setupDragSource(el: HTMLElement, item: DragItem) {
		el.addEventListener("dragstart", (e) => {
			e.stopPropagation();
			e.dataTransfer?.setData(DRAG_MIME, JSON.stringify(item));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			el.addClass("is-dragging");
		});
		el.addEventListener("dragend", () => {
			el.removeClass("is-dragging");
			this.treeEl.findAll(".is-drop-target").forEach((x) => x.removeClass("is-drop-target"));
		});
	}

	private setupDropTarget(el: HTMLElement, folderId: string | null) {
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			this.treeEl.findAll(".is-drop-target").forEach((x) => x !== el && x.removeClass("is-drop-target"));
			el.addClass("is-drop-target");
		});
		el.addEventListener("dragleave", (e) => {
			if (!el.contains(e.relatedTarget as Node)) el.removeClass("is-drop-target");
		});
		el.addEventListener("drop", (e) => {
			const raw = e.dataTransfer?.getData(DRAG_MIME);
			if (!raw) return;
			e.preventDefault();
			e.stopPropagation();
			el.removeClass("is-drop-target");
			const item = JSON.parse(raw) as DragItem;
			const plugin = this.view.plugin;
			if (item.type === "marker") {
				plugin.updateMarker(item.id, { folderId });
			} else if (item.id !== folderId && !plugin.isFolderInside(folderId, item.id)) {
				plugin.updateFolder(item.id, { parentId: folderId });
				if (folderId) plugin.updateFolder(folderId, { collapsed: false });
			}
		});
	}
}
