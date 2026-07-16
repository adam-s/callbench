/**
 * Display formatting shared across routes and components — the one copy of
 * each, so a rounding rule can't drift between the pages that show it.
 */

/** A coarse relative timestamp for run lists ("just now", "3h ago"). Coarse on
 * purpose: a run list needs recency at a glance, not a clock. */
export function ago(epochMs: number): string {
	const s = Math.max(0, (Date.now() - epochMs) / 1000);
	if (s < 90) return 'just now';
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	if (s < 129600) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

/** Seconds as m:ss for transport readouts. Non-finite input (a duration not
 * yet known) renders as 0:00 rather than NaN:NaN. */
export function fmtTime(sec: number): string {
	if (!Number.isFinite(sec)) return '0:00';
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}
