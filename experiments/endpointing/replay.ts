/**
 * Endpointing replay: score turn-end candidates against frozen call audio.
 * See README.md for the method. Deterministic, offline, bounded by the take
 * corpus; output is one diffable table.
 *
 * Structure: a CLASSIFIER turns a channel into a per-20ms-frame speech/silence
 * timeline (the energy threshold; neural classifiers are scored by neural_gate.py, whose reference implementations avoid hand-rolled frontends); the
 * WINDOW MACHINE — the same provisional/confirm logic the live detector runs —
 * turns a timeline into turn-end times. Candidates are classifier × confirm
 * window, all scored against one classifier-independent-enough reference
 * (energy runs merged across gaps ≤1500ms). The smart-turn semantic gate is
 * scored by smart_turn_gate.py (it needs Whisper's exact mel frontend).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePcm } from '@callbench/transport';
import { DEFAULT_TURN_CONFIG, frameEnergy } from '@callbench/turn';

const FRAME = 160; // 20ms @ 8kHz
const MERGE_GAP_MS = 1500; // reference: intra-utterance pauses up to this merge
const SPEECH = DEFAULT_TURN_CONFIG.speechEnergy;
const MIN_SPEECH_MS = DEFAULT_TURN_CONFIG.minSpeechMs;

const takesArg = process.argv.indexOf('--takes');
const takeLimit = takesArg >= 0 ? Number(process.argv[takesArg + 1]) : Infinity;

/** Split a stereo 8k PCM16 WAV into per-channel mono Int16Arrays. */
function channels(wav: Buffer): [Int16Array, Int16Array] | null {
	if (wav.length < 44) return null;
	if (wav.readUInt16LE(22) !== 2 || wav.readUInt32LE(24) !== 8000) return null;
	const n = (wav.length - 44) >> 2;
	const left = new Int16Array(n);
	const right = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		left[i] = wav.readInt16LE(44 + i * 4);
		right[i] = wav.readInt16LE(46 + i * 4);
	}
	return [left, right];
}

/** Energy per 20ms frame, via the exact live-path measure (mulaw round trip). */
function energyTimeline(pcm: Int16Array): number[] {
	const out: number[] = [];
	for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
		out.push(frameEnergy(encodePcm(pcm.subarray(i, i + FRAME))));
	}
	return out;
}

/** Reference utterances from the energy timeline (see README). */
function referenceUtterances(energy: number[]): Array<{ startMs: number; endMs: number }> {
	const runs: Array<{ startMs: number; endMs: number }> = [];
	let cur: { startMs: number; endMs: number } | null = null;
	energy.forEach((e, f) => {
		if (e < SPEECH) return;
		const atMs = f * 20;
		if (cur && atMs - cur.endMs <= MERGE_GAP_MS) cur.endMs = atMs;
		else {
			if (cur) runs.push(cur);
			cur = { startMs: atMs, endMs: atMs };
		}
	});
	if (cur) runs.push(cur);
	return runs.filter((r) => r.endMs - r.startMs >= MIN_SPEECH_MS);
}

/** The live detector's two-stage logic over a boolean speech timeline:
 * accumulated speech ≥ minSpeech arms the turn; confirm-window silence ends
 * it; the machine re-arms after each end, as the live loop does. */
function turnEnds(speech: boolean[], confirmMs: number): number[] {
	const ends: number[] = [];
	let spokeMs = 0;
	let lastSpeechMs: number | null = null;
	for (let f = 0; f < speech.length; f++) {
		const atMs = f * 20;
		if (speech[f]) {
			spokeMs += 20;
			lastSpeechMs = atMs;
			continue;
		}
		if (lastSpeechMs === null) continue;
		if (atMs - lastSpeechMs >= confirmMs) {
			if (spokeMs >= MIN_SPEECH_MS) ends.push(atMs);
			spokeMs = 0;
			lastSpeechMs = null;
		}
	}
	return ends;
}

interface Score {
	utterances: number;
	splits: number;
	misses: number;
	waits: number[];
}

function score(ends: number[], refs: Array<{ startMs: number; endMs: number }>): Score {
	const s: Score = { utterances: refs.length, splits: 0, misses: 0, waits: [] };
	for (const ref of refs) {
		s.splits += ends.filter((e) => e >= ref.startMs && e < ref.endMs).length;
		const after = ends.find((e) => e >= ref.endMs && e <= ref.endMs + 5000);
		if (after === undefined) s.misses++;
		else s.waits.push(after - ref.endMs);
	}
	return s;
}

const CONFIRMS = [300, 450, 600, 750, 900, 1200];

async function main(): Promise<void> {
	const takesDir = join(import.meta.dirname, '../../data/live-sim');
	const takes = readdirSync(takesDir)
		.filter((d) => /^\d{13}$/.test(d) && existsSync(join(takesDir, d, 'twilio-recording.wav')))
		.sort()
		.reverse()
		.slice(0, takeLimit);

	const totals = new Map<string, Score>();
	const add = (name: string, s: Score) => {
		const t = totals.get(name) ?? { utterances: 0, splits: 0, misses: 0, waits: [] };
		t.utterances += s.utterances;
		t.splits += s.splits;
		t.misses += s.misses;
		t.waits.push(...s.waits);
		totals.set(name, t);
	};

	let channelsScored = 0;
	for (const take of takes) {
		const chans = channels(readFileSync(join(takesDir, take, 'twilio-recording.wav')));
		if (!chans) continue;
		for (const pcm of chans) {
			const energy = energyTimeline(pcm);
			const refs = referenceUtterances(energy);
			if (refs.length === 0) continue;
			channelsScored++;
			const energySpeech = energy.map((e) => e >= SPEECH);
			for (const confirm of CONFIRMS) {
				add(`energy/${confirm}ms`, score(turnEnds(energySpeech, confirm), refs));
			}
		}
	}

	const med = (xs: number[]) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? (s[s.length >> 1] as number) : 0;
	};
	console.log(`takes=${takes.length} channels=${channelsScored}`);
	console.log('candidate      utterances  splits  split-rate  miss  median-wait');
	for (const [name, t] of [...totals.entries()].sort()) {
		console.log(
			`${name.padEnd(14)} ${String(t.utterances).padStart(10)} ${String(t.splits).padStart(7)} ${((t.splits / Math.max(1, t.utterances)) * 100).toFixed(1).padStart(9)}% ${String(t.misses).padStart(5)} ${med(t.waits).toFixed(0).padStart(9)}ms`,
		);
	}
}

await main();
