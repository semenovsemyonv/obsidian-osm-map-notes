import { requestUrl } from "obsidian";

/** Поиск адресов: Nominatim и Photon (оба на данных OSM, без ключа API), результаты объединяются. */

export interface GeoResult {
	/** короткое название: «5-я просека, 95Б» или имя объекта */
	name: string;
	/** полный адрес */
	detail: string;
	/** [lng, lat] */
	coords: [number, number];
	/** [запад, юг, восток, север] */
	bounds: [number, number, number, number] | null;
	/** номер дома, если найден дом */
	house?: string;
}

const USER_AGENT = "obsidian-osm-map-notes (https://github.com/semenovsemyonv/obsidian-osm-map-notes)";
const LIMIT = 6;

// Nominatim не понимает сокращения российских адресов («г.Самара ул.5-я просека»):
// служебные убираем, типы улиц раскрываем.
const ABBREVIATIONS: [RegExp, string][] = [
	[/(^|[\s,])(кв|квартира|оф|офис)\.?\s*\d+\S*/gi, "$1"],
	// «д. 12, корп. 2» → «12к2», «стр. 3» → «с3» — так дома записаны в OSM
	[/(\d+[а-яё]?)[\s,]*(корп|корпус|к)\.?\s*(\d+)/gi, "$1к$3"],
	[/(\d+[а-яё]?)[\s,]*(стр|строение)\.?\s*(\d+)/gi, "$1с$3"],
	[/(^|[\s,])(г|гор|ул|д|дом|корп|стр|лит|пос|с|дер|мкр|мкрн)\.\s*/gi, "$1"],
	[/(^|[\s,])(город|улица|корпус|строение)(?=\s)/gi, "$1"],
	[/(^|[\s,])(г|ул|д)\s+(?=[А-ЯЁ0-9])/g, "$1"],
	[/(^|[\s,])(пр-кт|пр-т|просп)\.?(?=\s|$)/gi, "$1проспект"],
	[/(^|[\s,])пр-д\.?(?=\s|$)/gi, "$1проезд"],
	[/(^|[\s,])пер\.\s*/gi, "$1переулок "],
	[/(^|[\s,])б-р\.?(?=\s|$)/gi, "$1бульвар"],
	[/(^|[\s,])наб\.\s*/gi, "$1набережная "],
	[/(^|[\s,])пл\.\s*/gi, "$1площадь "],
	[/(^|[\s,])ш\.\s*/gi, "$1шоссе "],
	[/(^|[\s,])обл\.?(?=\s|,|$)/gi, "$1область"],
	[/(^|[\s,])р-н\.?(?=\s|,|$)/gi, "$1район"],
];

export function normalizeAddress(q: string): string {
	let s = ` ${q} `;
	for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
	return s.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}

/**
 * Оба геокодера плохо понимают русские адреса, но ошибаются по-разному,
 * поэтому спрашиваем оба и ставим выше результаты с номером дома из запроса.
 */
export async function geocode(query: string, lang: string): Promise<GeoResult[]> {
	const q = normalizeAddress(query);
	if (!q) return [];
	const [nom, pho] = await Promise.all([
		nominatim(q, lang).catch((e) => { console.error(e); return null; }),
		photon(q, lang).catch((e) => { console.error(e); return null; }),
	]);
	if (!nom && !pho) throw new Error("Сервисы поиска недоступны");

	const merged: GeoResult[] = [];
	for (const r of [...(nom ?? []), ...(pho ?? [])]) {
		// одна и та же точка из двух сервисов — оставляем первую
		if (merged.some((m) => distanceM(m.coords, r.coords) < 30 && m.name === r.name)) continue;
		merged.push(r);
	}
	const houses = new Set((q.match(/\d+[а-яёa-z]?(?:[кс]\d+)?/gi) ?? []).map(normHouse));
	const score = (r: GeoResult) => (r.house && houses.has(normHouse(r.house)) ? 0 : 1);
	return merged
		.map((r, i) => ({ r, i }))
		.sort((a, b) => score(a.r) - score(b.r) || a.i - b.i)
		.map((x) => x.r)
		.slice(0, 8);
}

function normHouse(h: string): string {
	return h.toLowerCase().replace(/\s|корпус|корп\.?/g, (m) => (/\s/.test(m) ? "" : "к"));
}

function distanceM([lng1, lat1]: number[], [lng2, lat2]: number[]): number {
	const k = Math.PI / 180;
	const x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k);
	const y = (lat2 - lat1) * k;
	return Math.hypot(x, y) * 6371000;
}

interface NominatimItem {
	lat: string;
	lon: string;
	name?: string;
	display_name: string;
	boundingbox?: [string, string, string, string];
	address?: Record<string, string>;
}

// правила Nominatim: не больше одного запроса в секунду
let lastNominatim = 0;

async function nominatim(q: string, lang: string): Promise<GeoResult[]> {
	const wait = lastNominatim + 1100 - Date.now();
	if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
	lastNominatim = Date.now();
	const params = new URLSearchParams({
		q, format: "jsonv2", limit: String(LIMIT), addressdetails: "1", "accept-language": lang,
	});
	const res = await requestUrl({
		url: `https://nominatim.openstreetmap.org/search?${params}`,
		headers: { "User-Agent": USER_AGENT },
	});
	const items = res.json as NominatimItem[];
	return items.map((it) => {
		const a = it.address ?? {};
		const street = a.road ?? a.pedestrian ?? a.square;
		const house = a.house_number;
		const name = it.name || [street, house].filter(Boolean).join(", ") || it.display_name.split(",")[0];
		const bb = it.boundingbox?.map(Number);
		return {
			name,
			detail: it.display_name,
			coords: [+it.lon, +it.lat],
			// boundingbox Nominatim: [юг, север, запад, восток]
			bounds: bb ? [bb[2], bb[0], bb[3], bb[1]] : null,
			house,
		};
	});
}

interface PhotonFeature {
	geometry: { coordinates: [number, number] };
	properties: Record<string, string | number[] | undefined> & { extent?: number[] };
}

async function photon(q: string, lang: string): Promise<GeoResult[]> {
	// Photon знает только de/en/fr; русские названия отдаёт по умолчанию (local)
	const params = new URLSearchParams({ q, limit: String(LIMIT) });
	if (lang === "en") params.set("lang", "en");
	const res = await requestUrl({ url: `https://photon.komoot.io/api/?${params}`, headers: { "User-Agent": USER_AGENT } });
	const features = (res.json as { features: PhotonFeature[] }).features ?? [];
	return features.map((f) => {
		const p = f.properties as Record<string, string | undefined>;
		const streetLine = [p.street, p.housenumber].filter(Boolean).join(", ");
		const name = p.name || streetLine || p.city || "Без названия";
		const detail = [p.name ? streetLine : "", p.city, p.state, p.country].filter(Boolean).join(", ");
		// extent Photon: [запад, север, восток, юг]
		const e = f.properties.extent;
		return {
			name,
			detail,
			coords: f.geometry.coordinates,
			bounds: e ? [e[0], e[3], e[2], e[1]] : null,
			house: p.housenumber,
		};
	});
}
