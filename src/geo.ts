/** Web Mercator в диапазоне [0..1] */
export function toMerc([lng, lat]: number[]): [number, number] {
	const x = (lng + 180) / 360;
	const s = Math.sin((lat * Math.PI) / 180);
	const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
	return [x, y];
}

export function fromMerc([x, y]: number[]): [number, number] {
	const lng = x * 360 - 180;
	const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
	return [lng, lat];
}

/**
 * Длина пути камеры при перелёте (map.flyTo), в «экранах» — та же формула, что в MapLibre
 * (оптимальный путь ван Вейка — Ньюмана).
 * @param screenPx размер экрана, px (max из ширины и высоты)
 * @param dZoom изменение масштаба
 * @param distPx расстояние между центрами в px при начальном масштабе
 */
export function flyPathScreens(screenPx: number, dZoom: number, distPx: number, curve = 1.42): number {
	const w0 = screenPx;
	const w1 = w0 / Math.pow(2, dZoom);
	const r2 = curve * curve;
	if (distPx > 1e-6) {
		const r = (i: 0 | 1) => {
			const b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * r2 * r2 * distPx * distPx) / (2 * (i ? w1 : w0) * r2 * distPx);
			return Math.log(Math.sqrt(b * b + 1) - b);
		};
		const s = (r(1) - r(0)) / curve;
		if (isFinite(s)) return s;
	}
	// только приближение / отдаление без сдвига
	return Math.abs(Math.log(w1 / w0)) / curve;
}

/**
 * Точка на границе прямоугольника, где его пересекает отрезок от (px,py) к центру.
 * null — если точка внутри прямоугольника.
 */
export function rectEdgePoint(
	px: number, py: number, x: number, y: number, w: number, h: number,
): [number, number] | null {
	const cx = x + w / 2;
	const cy = y + h / 2;
	const dx = cx - px;
	const dy = cy - py;
	if (Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2) return null;
	const tx = dx !== 0 ? w / 2 / Math.abs(dx) : Infinity;
	const ty = dy !== 0 ? h / 2 / Math.abs(dy) : Infinity;
	const t = Math.min(tx, ty);
	return [cx - dx * t, cy - dy * t];
}
