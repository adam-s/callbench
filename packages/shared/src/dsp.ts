/**
 * The one Goertzel — a single-bin DFT shared by every consumer that asks "how
 * much of this window's energy sits at frequency f?". Two packages need the
 * identical algorithm for different questions (audioqc's out-of-band check,
 * transport's loopback tone detector); one implementation keeps their answers
 * comparable and their bugs shared.
 *
 * The result is power at `freq` as a fraction of the window's total energy —
 * a ratio, so any uniform scaling of the samples (Int16 full-range vs ±1
 * floats) cancels and callers need not normalize first.
 */
export function goertzelFraction(
	pcm: ArrayLike<number>,
	from: number,
	len: number,
	freq: number,
	rate: number,
): number {
	const n = Math.min(len, pcm.length - from);
	if (n <= 0) return 0;
	const coeff = 2 * Math.cos((2 * Math.PI * freq) / rate);
	let s1 = 0;
	let s2 = 0;
	let total = 0;
	for (let i = 0; i < n; i++) {
		const x = pcm[from + i] ?? 0;
		total += x * x;
		const s0 = x + coeff * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
	// Normalized against the window's total energy so the result is a fraction,
	// not an amplitude — comparable across windows regardless of loudness.
	return total > 0 ? power / (total * n) : 0;
}
