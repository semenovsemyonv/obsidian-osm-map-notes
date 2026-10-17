/** Хранилище скачанных тайлов в IndexedDB (локально на устройстве, не синхронизируется) */
const STORE = "tiles";

interface TileRecord {
	data: ArrayBuffer;
	/** время скачивания, мс */
	t: number;
}

export class TileStore {
	private dbPromise: Promise<IDBDatabase> | null = null;

	constructor(private dbName: string) {}

	private db(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			this.dbPromise = new Promise((resolve, reject) => {
				const req = indexedDB.open(this.dbName, 1);
				req.onupgradeneeded = () => req.result.createObjectStore(STORE);
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		}
		return this.dbPromise;
	}

	private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const db = await this.db();
		return new Promise((resolve, reject) => {
			const req = fn(db.transaction(STORE, mode).objectStore(STORE));
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async get(key: string): Promise<TileRecord | undefined> {
		return this.tx("readonly", (s) => s.get(key) as IDBRequest<TileRecord | undefined>);
	}

	async put(key: string, data: ArrayBuffer): Promise<void> {
		await this.tx("readwrite", (s) => s.put({ data, t: Date.now() } as TileRecord, key));
	}

	async deleteMany(keys: string[]): Promise<void> {
		const db = await this.db();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			for (const k of keys) store.delete(k);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	async clear(): Promise<void> {
		await this.tx("readwrite", (s) => s.clear());
	}

	close() {
		this.dbPromise?.then((db) => db.close()).catch(() => undefined);
		this.dbPromise = null;
	}
}
