/**
 * Generates the committed fixture runs the UI renders — deterministic scenario
 * runs over the simulator, with SYNTHESIZED call audio so the centerpiece
 * gesture (click a finding → hear that moment) works offline. NOT part of the
 * test suite (it calls the real judge once and shells out to macOS `say`);
 * re-run by hand, on macOS, to refresh:
 *
 *   node apps/web/fixtures/generate-runs.mjs
 *
 * Honesty: the simulator has no microphone, so this audio is SYNTHESIZED from the
 * turn text via macOS `say` — the artifact's `audio.synthetic` says so, and the
 * UI labels it. It stands in for a real call recording until a live loopback runs
 * real audio through the very same components. Because the audio is synthesized,
 * the transcript's turn timings are taken FROM the real spoken durations (not the
 * offline simulator's placeholder 1s), so the waveform and the transcript spans
 * align by construction.
 *
 * Two runs of the windshield-quote scenario: baseline (all PASS) and
 * fabricateAnswer (one FAIL). Both are SIMULATOR runs — replayable, no line rings.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeRunner, MapCache } from '@callbench/judge';
import {
	assess,
	buildRunArtifact,
	serializeRunArtifact,
	windshieldQuote,
} from '@callbench/scenario';
import { INITIAL_MEMORY, step } from '@callbench/simulator';
import { Transcript } from '@callbench/transcript';

const here = dirname(fileURLToPath(import.meta.url));
const runsRoot = join(here, 'runs');

const SAMPLE_RATE = 8000; // phone-band mono, closest to the real Twilio surface
const GAP_MS = 350; // silence between turns
const BENCH_VOICE = 'Alex'; // the caller
const AGENT_VOICE = 'Samantha'; // the simulator
const BASE_EPOCH = 1_784_000_000_000;

const NO_DEFECTS = { fabricateAnswer: false, dropCorrection: false, goSilentAtQuote: false };
const scratch = mkdtempSync(join(tmpdir(), 'callbench-audio-'));

/** Read a canonical PCM16 mono WAV into an Int16Array (parses fmt + data chunks). */
function readWavPcm16(path) {
	const buf = readFileSync(path);
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error(`not a WAV file: ${path}`);
	}
	let off = 12;
	let dataOff = -1;
	let dataLen = 0;
	while (off + 8 <= buf.length) {
		const id = buf.toString('ascii', off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === 'data') {
			dataOff = off + 8;
			dataLen = size;
			break;
		}
		off += 8 + size + (size % 2);
	}
	if (dataOff < 0) throw new Error(`no data chunk in ${path}`);
	const samples = new Int16Array(dataLen / 2);
	for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(dataOff + i * 2);
	return samples;
}

/** Synthesize one turn to PCM16 mono at SAMPLE_RATE via macOS say + afconvert. */
function synth(text, voice, tag) {
	const aiff = join(scratch, `${tag}.aiff`);
	const wav = join(scratch, `${tag}.wav`);
	execFileSync('say', ['-v', voice, '-o', aiff, text]);
	execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', aiff, wav]);
	return readWavPcm16(wav);
}

/** Write an Int16Array as a PCM16 mono WAV file. */
function writeWavPcm16(path, samples) {
	const dataLen = samples.length * 2;
	const buf = Buffer.alloc(44 + dataLen);
	buf.write('RIFF', 0, 'ascii');
	buf.writeUInt32LE(36 + dataLen, 4);
	buf.write('WAVE', 8, 'ascii');
	buf.write('fmt ', 12, 'ascii');
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(SAMPLE_RATE, 24);
	buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits
	buf.write('data', 36, 'ascii');
	buf.writeUInt32LE(dataLen, 40);
	for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
	writeFileSync(path, buf);
}

const runner = claudeRunner('sonnet');
const cache = new MapCache();

const specs = [
	{ label: 'baseline', defects: NO_DEFECTS, createdEpochMs: BASE_EPOCH },
	{
		label: 'fabricateCamera',
		defects: { ...NO_DEFECTS, fabricateAnswer: true },
		createdEpochMs: BASE_EPOCH + 60_000,
	},
];

rmSync(join(runsRoot, windshieldQuote.name), { recursive: true, force: true });

for (const spec of specs) {
	// Drive the simulator, synthesizing each turn and taking timings from the real
	// spoken durations so the audio and the transcript share one clock.
	const transcript = new Transcript(spec.createdEpochMs);
	const placed = []; // { startSample, pcm }
	let memory = INITIAL_MEMORY;
	let cursorMs = 0;
	let ti = 0;

	const emit = (speaker, text, voice) => {
		const pcm = synth(text, voice, `${spec.label}-${ti++}`);
		const durMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);
		const startMs = cursorMs;
		const endMs = startMs + durMs;
		placed.push({ startSample: Math.round((startMs / 1000) * SAMPLE_RATE), pcm });
		transcript.append({
			speaker,
			text,
			startMs,
			endMs,
			confidence: speaker === 'target' ? { score: 1, raw: { simulator: 1 } } : null,
			provider: speaker === 'target' ? 'simulator' : 'scripted',
		});
		cursorMs = endMs + GAP_MS;
	};

	for (const turn of windshieldQuote.caller) {
		const line = typeof turn === 'string' ? turn : turn.say;
		emit('bench', line, BENCH_VOICE);
		const reply = step(memory, line, spec.defects, windshieldQuote.simScript);
		memory = reply.memory;
		if (reply.say !== null) emit('target', reply.say, AGENT_VOICE);
	}

	const frozen = transcript.freeze();
	const report = await assess(windshieldQuote, frozen, { runner, cache });

	// Assemble the full call: one silence buffer, each turn placed at its offset.
	const totalSamples = Math.ceil((cursorMs / 1000) * SAMPLE_RATE);
	const full = new Int16Array(totalSamples);
	for (const { startSample, pcm } of placed) full.set(pcm, startSample);

	const dir = join(runsRoot, windshieldQuote.name, frozen.hash);
	mkdirSync(dir, { recursive: true });
	const wavPath = join(dir, 'call.wav');
	writeWavPcm16(wavPath, full);
	const sha256 = createHash('sha256').update(readFileSync(wavPath)).digest('hex');

	const artifact = buildRunArtifact(
		windshieldQuote.name,
		'simulator',
		frozen,
		report,
		spec.createdEpochMs,
		{
			file: 'call.wav',
			sampleRate: SAMPLE_RATE,
			channels: 1,
			durationMs: Math.round((totalSamples / SAMPLE_RATE) * 1000),
			sha256,
			synthetic: 'macos-say',
		},
	);
	writeFileSync(join(dir, 'run.json'), serializeRunArtifact(artifact));

	const { PASS, FAIL, INCONCLUSIVE } = report.counts;
	console.log(
		`${spec.label.padEnd(16)} run ${frozen.hash.slice(0, 12)}  ${totalSamples} samples ${(totalSamples / SAMPLE_RATE).toFixed(1)}s  PASS ${PASS} FAIL ${FAIL} INCONCLUSIVE ${INCONCLUSIVE}`,
	);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nwrote audio-backed fixtures under ${join(runsRoot, windshieldQuote.name)}`);
