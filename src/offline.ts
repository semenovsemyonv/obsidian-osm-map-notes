import { Notice, requestUrl } from "obsidian";
import * as maplibregl from "maplibre-gl";
import type MapNotesPlugin from "./main";
import { TileStore } from "./tileStore";
import { OfflineRegion, TileProvider, uid } from "./types";

export const OFFLINE_PROTOCOL = "mapnotes";
/** Ограничения для скачивания — чтобы не нарушать правила тайловых серверов */
export const MAX_TILES_PER_REGION = 30000;
const PROVIDER_MAX_OFFLINE_ZOOM: Record<string, number> = { osm: 16 };
const AVG_TILE_BYTES = 25_000;

// прозрачный PNG 1×1 — для отсутствующих тайлов
const EMPTY_TILE = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
	(c) => c.charCodeAt(0),
).buffer;

function toBitmap(data: ArrayBuffer): Promise<ImageBitmap> {
	return createImageBitmap(new Blob([data]));
}

// ---------------- математика тайлов ----------------

function lngToX(lng: number, z: number): number {
	const n = 2 ** z;
	return Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
}

function latToY(lat: number, z: number): number {
	const n = 2 ** z;
	const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
	const r = (clamped * Math.PI) / 180;
	const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
	return Math.min(n - 1, Math.max(0, Math.floor(y)));
}

type Bounds = [number, number, number, number];

function tileRange(b: Bounds, z: number) {
	return { x0: lngToX(b[0], z), x1: lngToX(b[2], z), y0: latToY(b[3], z), y1: latToY(b[1], z) };
}

/** Все тайлы области от z=0 до maxZoom (сначала мелкие масштабы) */
export function* regionTiles(b: Bounds, maxZoom: number): Generator<[number, number, number]> {
	for (let z = 0; z <= maxZoom; z++) {
		const r = tileRange(b, z);
		for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [z, x, y];
	}
}

export function countTiles(b: Bounds, maxZoom: number): number {
	let n = 0;
	for (let z = 0; z <= maxZoom; z++) {
		const r = tileRange(b, z);
		n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
	}
	return n;
}

export function estimateBytes(tiles: number): number {
	return tiles * AVG_TILE_BYTES;
}

export function maxOfflineZoom(provider: TileProvider): number {
	return Math.min(provider.maxzoom, PROVIDER_MAX_OFFLINE_ZOOM[provider.key] ?? 18);
}

function inRegion(r: OfflineRegion, z: number, x: number, y: number): boolean {
	if (z > r.maxZoom) return false;
	const t = tileRange(r.bounds, z);
	return x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1;
}

const tileKey = (providerKey: string, z: number, x: number, y: number) => `${providerKey}/${z}/${x}/${y}`;

function tileUrl(templates: string[], z: number, x: number, y: number): string {
	return templates[(x + y) % templates.length]
		.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} Б`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} КБ`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
	return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

// ---------------- менеджер офлайн-карт ----------------

export interface DownloadJob {
	regionId: string;
	kind: "download" | "update";
	total: number;
	done: number;
	failed: number;
	bytes: number;
	cancelled: boolean;
}

/**
 * Скачивает области в IndexedDB и отдаёт их карте через протокол mapnotes://.
 * События плагина: "offline-progress" (job) и "offline-changed".
 */
export class OfflineManager {
	store: TileStore;
	job: DownloadJob | null = null;
	private queue: { regionId: string; kind: "download" | "update" }[] = [];

	constructor(private plugin: MapNotesPlugin) {
		const appId = (plugin.app as unknown as { appId?: string }).appId ?? "default";
		this.store = new TileStore(`map-notes-tiles-${appId}`);

		maplibregl.addProtocol(OFFLINE_PROTOCOL, async (params) => {
			// mapnotes://<providerKey>/<z>/<x>/<y>
			const [enc, z, x, y] = params.url.slice(OFFLINE_PROTOCOL.length + 3).split("/");
			const providerKey = decodeURIComponent(enc);
			// отдаём готовое изображение: сырые байты из своего протокола MapLibre 4 не дорисовывает
			const rec = await this.store.get(tileKey(providerKey, +z, +x, +y));
			if (rec) return { data: await toBitmap(rec.data) };
			if (this.plugin.settings.offlineNetworkFallback && navigator.onLine) {
				const provider = this.plugin.currentProvider();
				if (provider.key === providerKey) {
					const res = await requestUrl({ url: tileUrl(provider.tiles, +z, +x, +y), throw: false });
					if (res.status === 200) return { data: await toBitmap(res.arrayBuffer) };
				}
			}
			return { data: await toBitmap(EMPTY_TILE) };
		});
	}

	unload() {
		if (this.job) this.job.cancelled = true;
		this.queue = [];
		maplibregl.removeProtocol(OFFLINE_PROTOCOL);
		this.store.close();
	}

	/** Максимальный скачанный масштаб для подложки — выше него карта растягивает тайлы */
	maxDownloadedZoom(providerKey: string): number | null {
		const zs = this.plugin.data.regions.filter((r) => r.providerKey === providerKey).map((r) => r.maxZoom);
		return zs.length ? Math.max(...zs) : null;
	}

	createRegion(name: string, provider: TileProvider, bounds: Bounds, maxZoom: number): OfflineRegion {
		const region: OfflineRegion = {
			id: uid(),
			name,
			providerKey: provider.key,
			providerName: provider.name,
			tiles: provider.tiles,
			bounds,
			maxZoom,
			tileCount: countTiles(bounds, maxZoom),
			bytes: 0,
			failed: 0,
			downloadedAt: 0,
		};
		this.plugin.data.regions.push(region);
		this.plugin.save(false);
		this.enqueue(region.id, "download");
		return region;
	}

	enqueue(regionId: string, kind: "download" | "update") {
		if (this.job?.regionId === regionId || this.queue.some((q) => q.regionId === regionId)) return;
		this.queue.push({ regionId, kind });
		this.plugin.events.trigger("offline-changed");
		if (!this.job) this.runQueue();
	}

	updateAll() {
		for (const r of this.plugin.data.regions) this.enqueue(r.id, "update");
	}

	isQueued(regionId: string): boolean {
		return this.queue.some((q) => q.regionId === regionId);
	}

	cancel(regionId: string) {
		this.queue = this.queue.filter((q) => q.regionId !== regionId);
		if (this.job?.regionId === regionId) this.job.cancelled = true;
		this.plugin.events.trigger("offline-changed");
	}

	private async runQueue() {
		while (this.queue.length) {
			const next = this.queue.shift()!;
			const region = this.plugin.data.regions.find((r) => r.id === next.regionId);
			if (!region) continue;
			await this.runJob(region, next.kind);
		}
		this.job = null;
		this.plugin.events.trigger("offline-changed");
		if (this.plugin.settings.mapMode === "offline") this.plugin.events.trigger("tiles-changed");
	}

	private async runJob(region: OfflineRegion, kind: "download" | "update") {
		const job: DownloadJob = { regionId: region.id, kind, total: region.tileCount, done: 0, failed: 0, bytes: 0, cancelled: false };
		this.job = job;
		this.plugin.events.trigger("offline-changed");

		const iter = regionTiles(region.bounds, region.maxZoom);
		// к OSM — не больше 2 одновременных запросов (правила tile.openstreetmap.org)
		const concurrency = region.providerKey === "osm" ? 2 : 4;
		let lastEmit = 0;

		const worker = async () => {
			for (;;) {
				if (job.cancelled) return;
				const next = iter.next();
				if (next.done) return;
				const [z, x, y] = next.value;
				const key = tileKey(region.providerKey, z, x, y);
				try {
					const existing = kind === "download" ? await this.store.get(key) : undefined;
					if (existing) {
						job.bytes += existing.data.byteLength;
					} else {
						const res = await requestUrl({ url: tileUrl(region.tiles, z, x, y), throw: false });
						if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
						await this.store.put(key, res.arrayBuffer);
						job.bytes += res.arrayBuffer.byteLength;
					}
				} catch (e) {
					job.failed++;
				}
				job.done++;
				const now = performance.now();
				if (now - lastEmit > 150) {
					lastEmit = now;
					this.plugin.events.trigger("offline-progress", job);
				}
			}
		};
		await Promise.all(Array.from({ length: concurrency }, worker));

		if (!this.plugin.data.regions.includes(region)) return; // область удалили во время скачивания
		if (job.cancelled) {
			new Notice(`Скачивание «${region.name}» остановлено`);
		} else {
			region.bytes = job.bytes;
			region.failed = job.failed;
			region.downloadedAt = Date.now();
			new Notice(job.failed
				? `«${region.name}»: скачано с ошибками (${job.failed} из ${job.total} тайлов не загрузились)`
				: `«${region.name}» ${kind === "update" ? "обновлена" : "скачана"} — ${formatBytes(job.bytes)}`);
		}
		this.plugin.save(false);
		this.plugin.events.trigger("offline-progress", job);
	}

	/** Удаляет область и её тайлы, если они не входят в другие области той же подложки */
	async deleteRegion(regionId: string) {
		this.cancel(regionId);
		const region = this.plugin.data.regions.find((r) => r.id === regionId);
		if (!region) return;
		this.plugin.data.regions = this.plugin.data.regions.filter((r) => r.id !== regionId);
		this.plugin.save(false);
		this.plugin.events.trigger("offline-changed");

		const others = this.plugin.data.regions.filter((r) => r.providerKey === region.providerKey);
		let batch: string[] = [];
		for (const [z, x, y] of regionTiles(region.bounds, region.maxZoom)) {
			if (others.some((o) => inRegion(o, z, x, y))) continue;
			batch.push(tileKey(region.providerKey, z, x, y));
			if (batch.length >= 2000) {
				await this.store.deleteMany(batch);
				batch = [];
			}
		}
		if (batch.length) await this.store.deleteMany(batch);
		this.plugin.events.trigger("tiles-changed");
	}
}
