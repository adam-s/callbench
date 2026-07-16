/**
 * Persona fidelity probe: are the LLM's improvised caller lines faithful to
 * the REAL warm-up call's beats WITHOUT copying its words?
 *
 * Reference: the maintainer's own lines from the real call
 * (data/calls/2026-07-15-warm-up-windshield/transcript.md). Two measures per
 * take, both diffable, no model judgment:
 *
 *   - BEAT COVERAGE — the conversational beats the real caller hit (vehicle
 *     intro, unsure-about-ADAS + how to tell, price, OEM vs aftermarket,
 *     duration, mobile service) found in the persona's lines by keyword class;
 *   - VERBATIM OVERLAP — the longest common word run between any persona line
 *     and any real-caller line. The designed probe is exempt (it is verbatim
 *     BY DESIGN); anything else long enough to be a copied sentence fails.
 *
 * Usage: node scripts/probes/persona-fidelity.ts <take-dir>
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const takeDir = process.argv[2];
if (!takeDir) throw new Error('usage: persona-fidelity.ts <take-dir>');

const REAL = join(
	import.meta.dirname,
	'../../data/calls/2026-07-15-warm-up-windshield/transcript.md',
);
const PROBE_EXEMPT = /camera recalibration/i;

const realLines = [...readFileSync(REAL, 'utf8').matchAll(/\*\*Adam:\*\* ([^\n]+)/g)]
	.map((m) => (m[1] as string).trim())
	.filter((l) => l.length > 0);

const transcript = JSON.parse(readFileSync(join(takeDir, 'transcript.json'), 'utf8')) as {
	turns: Array<{ speaker: string; text: string }>;
};
const personaLines = transcript.turns
	.filter((t) => t.speaker === 'bench' && !PROBE_EXEMPT.test(t.text))
	.map((t) => t.text);

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9' ]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);

/** Longest common contiguous word run between two strings. */
function longestRun(a: string[], b: string[]): number {
	let best = 0;
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			let k = 0;
			while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
			if (k > best) best = k;
		}
	}
	return best;
}

const BEATS: Array<[string, RegExp]> = [
	['vehicle intro', /\b(?:2009|audi|a3)\b/i],
	['unsure about ADAS / how to tell', /not sure|how (?:would|could|do) i (?:know|tell)/i],
	['price asked', /price|how much|cost/i],
	['OEM vs aftermarket', /oem|aftermarket/i],
	['duration asked', /how long|take|hours?|day/i],
	['mobile service asked', /mobile|at my house|come to/i],
];

console.log(`take: ${takeDir}`);
console.log(`real caller lines: ${realLines.length}; persona lines: ${personaLines.length}\n`);

console.log('BEAT COVERAGE (the real call’s beats, hit in the persona’s own words):');
for (const [name, re] of BEATS) {
	const hit = personaLines.find((l) => re.test(l));
	console.log(`  ${hit ? 'HIT ' : 'MISS'}  ${name}${hit ? ` — "${hit.slice(0, 60)}"` : ''}`);
}

console.log('\nVERBATIM OVERLAP vs the real caller (probe exempt):');
let worst = 0;
let worstPair: [string, string] = ['', ''];
for (const p of personaLines) {
	for (const r of realLines) {
		const run = longestRun(words(p), words(r));
		if (run > worst) {
			worst = run;
			worstPair = [p, r];
		}
	}
}
console.log(`  longest common word run: ${worst} words`);
if (worst >= 6) {
	console.log(`  COPYING SUSPECT:\n    persona: "${worstPair[0]}"\n    real:    "${worstPair[1]}"`);
} else {
	console.log('  no copied sentences: everything ≥6 words is original phrasing.');
}
