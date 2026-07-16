/**
 * Take-variance analysis — the "some findings only exist under repetition"
 * half of the brief. Reads N frozen takes of ONE scenario and reports, as
 * deterministic diffable text: per-turn STT confidence spread, target
 * response-latency distribution, and every distinct transcription each turn
 * position produced. No network, no model, no call — a pure read of frozen
 * artifacts (a derived report, source untouched).
 *
 * Usage: node scripts/analyze-takes.ts data/live-sim/<epoch> [more take dirs…]
 *        node scripts/analyze-takes.ts data/live-sim/*            # glob is fine
 *
 * Dirs whose meta names a different scenario or a defect are skipped loudly —
 * mixing defect takes into a baseline distribution would report the defect as
 * variance. Output goes to stdout and to data/live-sim/analysis/<scenario>-
 * variance-<latest-epoch>.md (named by the newest take analyzed, so re-running
 * over the same takes overwrites the same file — no timestamp drift).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FrozenTranscript } from '@callbench/transcript';

interface Meta {
	scenario: string;
	defect: string | null;
	callSid: string;
	anchorEpochMs: number;
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[i] as number;
}

function main(): void {
	const dirs = process.argv.slice(2).filter((d) => existsSync(join(d, 'transcript.json')));
	if (dirs.length === 0) throw new Error('usage: analyze-takes.ts <take dir> [more…]');

	const takes: Array<{ dir: string; meta: Meta; transcript: FrozenTranscript }> = [];
	let scenarioName: string | null = null;
	for (const dir of dirs) {
		const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
		if (meta.defect) {
			console.log(`skip   : ${basename(dir)} — defect take (${meta.defect}), not variance`);
			continue;
		}
		if (scenarioName === null) scenarioName = meta.scenario;
		if (meta.scenario !== scenarioName) {
			console.log(`skip   : ${basename(dir)} — scenario ${meta.scenario} ≠ ${scenarioName}`);
			continue;
		}
		takes.push({
			dir,
			meta,
			transcript: JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')),
		});
	}
	if (takes.length < 2) throw new Error(`need ≥2 comparable takes, have ${takes.length}`);
	takes.sort((a, b) => a.meta.anchorEpochMs - b.meta.anchorEpochMs);

	const lines: string[] = [
		`# Take variance — ${scenarioName} (${takes.length} baseline takes)`,
		'',
		`Takes: ${takes.map((t) => basename(t.dir)).join(', ')}`,
		'',
	];

	// Align turns by position (the scripted flow is lockstep, so position is
	// identity; a take with a different turn count is itself a finding).
	const turnCounts = new Set(takes.map((t) => t.transcript.turns.length));
	lines.push(
		`Turn counts: ${[...turnCounts].join(', ')}${turnCounts.size > 1 ? '  ← DIVERGENT' : ''}`,
		'',
	);

	const maxTurns = Math.max(...takes.map((t) => t.transcript.turns.length));

	// Per-position: confidence spread and every distinct transcription.
	lines.push('## Target turns — confidence spread and transcription variants', '');
	for (let i = 0; i < maxTurns; i++) {
		const at = takes
			.map((t) => t.transcript.turns[i])
			.filter((t) => t !== undefined && t.speaker === 'target');
		if (at.length === 0) continue;
		const confs = at
			.map((t) => t?.confidence?.score)
			.filter((c): c is number => c !== undefined && c !== null)
			.sort((a, b) => a - b);
		const texts = new Map<string, number>();
		for (const t of at) {
			const key = (t?.text ?? '').trim();
			texts.set(key, (texts.get(key) ?? 0) + 1);
		}
		lines.push(
			`### turn ${i} (target, in ${at.length}/${takes.length} takes) — conf min=${confs[0]?.toFixed(2)} med=${pct(confs, 50).toFixed(2)} max=${confs[confs.length - 1]?.toFixed(2)}`,
		);
		for (const [text, n] of [...texts.entries()].sort((a, b) => b[1] - a[1])) {
			lines.push(`- ${n}×: "${text}"`);
		}
		lines.push('');
	}

	// Response latency: target turn start minus the preceding bench turn end.
	lines.push('## Target response latency (bench line end → target speech start)', '');
	const latencies: number[] = [];
	for (const t of takes) {
		const turns = t.transcript.turns;
		for (let i = 1; i < turns.length; i++) {
			const cur = turns[i];
			const prev = turns[i - 1];
			if (cur?.speaker === 'target' && prev?.speaker === 'bench') {
				latencies.push(cur.startMs - prev.endMs);
			}
		}
	}
	latencies.sort((a, b) => a - b);
	lines.push(
		`n=${latencies.length}  min=${latencies[0]}ms  p50=${pct(latencies, 50)}ms  p95=${pct(latencies, 95)}ms  max=${latencies[latencies.length - 1]}ms`,
		'',
		'NOTE: this measures the whole practice loop — Twilio transit, our sim leg',
		"hearing the turn out (700ms VAD hangover), its STT round trip, and the reply's",
		'transit back. It is the harness+simulator floor, NOT a claim about any real',
		"target's responsiveness; its use is spotting drift between takes and sizing",
		'what a live-target latency figure must subtract.',
		'',
	);

	// Whole-take agreement: how many takes produced an identical turn-text
	// sequence (the strongest single variance signal).
	const signatures = new Map<string, number>();
	for (const t of takes) {
		const sig = t.transcript.turns.map((x) => `${x.speaker}:${x.text.trim()}`).join('|');
		signatures.set(sig, (signatures.get(sig) ?? 0) + 1);
	}
	lines.push('## Whole-take agreement', '');
	lines.push(
		`${signatures.size} distinct transcript(s) across ${takes.length} takes` +
			(signatures.size === 1 ? ' — byte-identical transcription end to end.' : ':'),
	);
	if (signatures.size > 1) {
		let v = 0;
		for (const [, n] of [...signatures.entries()].sort((a, b) => b[1] - a[1])) {
			lines.push(`- variant ${++v}: ${n} take(s)`);
		}
	}
	lines.push('');

	const out = lines.join('\n');
	console.log(out);
	const latest = takes[takes.length - 1] as (typeof takes)[number];
	const outDir = join('data', 'live-sim', 'analysis');
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, `${scenarioName}-variance-${latest.meta.anchorEpochMs}.md`);
	writeFileSync(outPath, out);
	console.log(`written: ${outPath}`);
}

main();
