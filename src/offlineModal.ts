import { App, Modal, Setting, setIcon } from "obsidian";
import type MapNotesPlugin from "./main";
import type { MapView } from "./mapView";
import {
	DownloadJob, MAX_TILES_PER_REGION, countTiles, estimateBytes, formatBytes, maxOfflineZoom,
} from "./offline";
import { ConfirmModal } from "./modals";
import type { OfflineRegion } from "./types";

const sectionState: Record<string, boolean> = {};

/** Окно «Режим карты»: онлайн/офлайн, скачивание видимой области, список областей */
export class OfflineModal extends Modal {
	private listEl!: HTMLElement;
	private rowEls = new Map<string, HTMLElement>();

	constructor(app: App, private plugin: MapNotesPlugin, private view: MapView | null) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("gis-offline-modal");
		this.titleEl.setText("Режим карты");
		this.render();

		const ev = this.plugin.events;
		const onChanged = ev.on("offline-changed", () => this.renderList());
		const onProgress = ev.on("offline-progress", (job: DownloadJob) => this.updateProgress(job));
		this.unsubscribe = () => { ev.offref(onChanged); ev.offref(onProgress); };
	}

	private unsubscribe: () => void = () => undefined;

	onClose() {
		this.unsubscribe();
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		const s = this.plugin.settings;
		contentEl.empty();

		// ---- переключатель режима ----
		const seg = contentEl.createDiv("gis-mode-switch");
		const mk = (mode: "online" | "offline", icon: string, title: string, desc: string) => {
			const b = seg.createDiv({ cls: "gis-mode-option" + (s.mapMode === mode ? " is-active" : "") });
			setIcon(b.createDiv("gis-mode-option-icon"), icon);
			const t = b.createDiv();
			t.createDiv({ cls: "gis-mode-option-title", text: title });
			t.createDiv({ cls: "gis-mode-option-desc", text: desc });
			b.onclick = () => { this.plugin.setMapMode(mode); this.render(); };
		};
		mk("online", "wifi", "Онлайн", "Карта грузится из сети и всегда актуальна");
		mk("offline", "hard-drive-download", "Офлайн", "Только скачанные области, без интернета");

		if (s.mapMode === "offline") {
			new Setting(contentEl)
				.setName("Догружать из сети недостающее")
				.setDesc("Если тайла нет среди скачанных и есть интернет — взять его из сети.")
				.addToggle((t) => t.setValue(s.offlineNetworkFallback).onChange((v) => {
					s.offlineNetworkFallback = v;
					this.plugin.save(false);
					this.plugin.events.trigger("tiles-changed");
				}));
		}

		// ---- скачивание видимой области (раскрывающийся раздел) ----
		const dl = this.section(contentEl, "download", "Скачать видимую область", "download");
		const bounds = this.view?.getVisibleBounds() ?? null;
		if (!bounds) {
			dl.createDiv({ cls: "gis-muted", text: "Откройте карту, чтобы скачать область." });
		} else {
			const provider = this.plugin.currentProvider();
			if (s.tileProvider === "vector") {
				dl.createDiv({
					cls: "gis-muted gis-small",
					text: "Векторную карту скачать нельзя — будет скачана растровая OpenStreetMap, она и показывается в офлайн-режиме.",
				});
			}
			const zMax = maxOfflineZoom(provider);
			let maxZoom = Math.min(s.offlineMaxZoom, zMax);
			let name = `Область ${this.plugin.data.regions.length + 1}`;

			new Setting(dl).setName("Название").addText((t) => t.setValue(name).onChange((v) => (name = v)));
			const estimate = createDiv("gis-offline-estimate");
			let downloadBtn: HTMLButtonElement | null = null;
			const updateEstimate = () => {
				const n = countTiles(bounds, maxZoom);
				const tooMany = n > MAX_TILES_PER_REGION;
				estimate.setText(tooMany
					? `${n.toLocaleString("ru")} тайлов — слишком много (максимум ${MAX_TILES_PER_REGION.toLocaleString("ru")}). Уменьшите детализацию или приблизьте карту.`
					: `≈ ${n.toLocaleString("ru")} тайлов, ≈ ${formatBytes(estimateBytes(n))}`);
				estimate.toggleClass("is-error", tooMany);
				if (downloadBtn) downloadBtn.disabled = tooMany;
			};
			new Setting(dl)
				.setName("Детализация (макс. масштаб)")
				.setDesc(`Подложка: ${provider.name}. Максимум для офлайна: ${zMax}. 13 — город, 15 — улицы, 16 — дома.`)
				.addSlider((sl) => sl.setLimits(8, zMax, 1).setValue(maxZoom).setDynamicTooltip().onChange((v) => {
					maxZoom = v;
					s.offlineMaxZoom = v;
					this.plugin.save(false);
					updateEstimate();
				}));
			dl.appendChild(estimate);
			new Setting(dl).addButton((b) => {
				downloadBtn = b.buttonEl;
				b.setButtonText("Скачать").setCta().onClick(() => {
					this.plugin.offline.createRegion(name.trim() || "Область", provider, bounds, maxZoom);
				});
			});
			updateEstimate();
			if (provider.key === "osm") {
				dl.createDiv({
					cls: "gis-muted gis-small",
					text: "Сервер OpenStreetMap не рассчитан на массовое скачивание: скачивайте только нужные области.",
				});
			}
		}

		// ---- список скачанных областей (раскрывающийся раздел) ----
		const list = this.section(contentEl, "regions", "Скачанные области", "map", (summary) => {
			const updAll = summary.createEl("button", { text: "Обновить все", cls: "gis-section-action" });
			updAll.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.plugin.offline.updateAll();
			};
		});
		this.listEl = list.createDiv("gis-offline-list");
		this.renderList();
	}

	/** Раскрывающийся раздел; состояние (открыт/закрыт) запоминается, пока Obsidian запущен */
	private section(parent: HTMLElement, key: string, title: string, icon: string,
		extra?: (summary: HTMLElement) => void): HTMLElement {
		const details = parent.createEl("details", { cls: "gis-section" });
		details.open = sectionState[key] ?? key !== "download";
		const summary = details.createEl("summary", { cls: "gis-section-summary" });
		setIcon(summary.createSpan("gis-section-chevron"), "chevron-right");
		setIcon(summary.createSpan("gis-section-icon"), icon);
		summary.createSpan({ cls: "gis-section-title", text: title });
		extra?.(summary);
		details.addEventListener("toggle", () => (sectionState[key] = details.open));
		return details.createDiv("gis-section-body");
	}

	private renderList() {
		if (!this.listEl) return;
		this.listEl.empty();
		this.rowEls.clear();
		const regions = this.plugin.data.regions;
		const title = this.listEl.closest(".gis-section")?.querySelector(".gis-section-title");
		if (title) title.textContent = regions.length ? `Скачанные области · ${regions.length}` : "Скачанные области";
		if (!regions.length) {
			this.listEl.createDiv({ cls: "gis-muted", text: "Пока ничего не скачано." });
			return;
		}
		for (const r of [...regions].reverse()) this.renderRegion(r);
		const job = this.plugin.offline.job;
		if (job && isRunning(job)) this.updateProgress(job);
	}

	private renderRegion(r: OfflineRegion) {
		const off = this.plugin.offline;
		const row = this.listEl.createDiv("gis-offline-row");
		this.rowEls.set(r.id, row);

		const info = row.createDiv("gis-offline-info");
		info.createDiv({ cls: "gis-offline-name", text: r.name });
		const meta = [
			r.providerName,
			`до z${r.maxZoom}`,
			`${r.tileCount.toLocaleString("ru")} тайлов`,
			r.bytes ? formatBytes(r.bytes) : "",
			r.downloadedAt ? `обновлено ${new Date(r.downloadedAt).toLocaleDateString("ru")}` : "не скачано",
		].filter(Boolean).join(" · ");
		info.createDiv({ cls: "gis-offline-meta", text: meta });
		if (r.failed) info.createDiv({ cls: "gis-offline-meta is-error", text: `Не загрузилось тайлов: ${r.failed}` });
		const status = info.createDiv("gis-offline-status");
		if (off.isQueued(r.id)) status.setText("В очереди…");
		info.createDiv("gis-progress").createDiv("gis-progress-bar");

		const actions = row.createDiv("gis-offline-actions");
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = fn;
		};
		const busy = off.job?.regionId === r.id || off.isQueued(r.id);
		if (this.view) btn("locate-fixed", "Показать на карте", () => { this.view!.fitBounds(r.bounds); this.close(); });
		if (busy) btn("square", "Остановить", () => off.cancel(r.id));
		else btn("refresh-cw", "Обновить (скачать заново)", () => off.enqueue(r.id, "update"));
		btn("trash-2", "Удалить", () => new ConfirmModal(this.app, `Удалить скачанную область «${r.name}»?`,
			() => off.deleteRegion(r.id)).open());
	}

	private updateProgress(job: DownloadJob) {
		const row = this.rowEls.get(job.regionId);
		if (!row) return;
		const running = isRunning(job);
		row.toggleClass("is-running", running);
		const pct = job.total ? (job.done / job.total) * 100 : 0;
		(row.querySelector(".gis-progress-bar") as HTMLElement).style.width = `${pct}%`;
		row.querySelector(".gis-offline-status")!.textContent = running
			? `${job.kind === "update" ? "Обновление" : "Скачивание"}: ${job.done.toLocaleString("ru")} / ${job.total.toLocaleString("ru")} · ${formatBytes(job.bytes)}${job.failed ? ` · ошибок: ${job.failed}` : ""}`
			: "";
		if (!running) this.renderList();
	}
}

function isRunning(job: DownloadJob): boolean {
	return !job.cancelled && job.done < job.total;
}
