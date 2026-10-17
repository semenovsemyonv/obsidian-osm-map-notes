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

export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
