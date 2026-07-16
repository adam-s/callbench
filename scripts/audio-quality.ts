/**
 * Audio-quality report over WAV files — a thin entry point; every metric and
 * its rationale lives in @callbench/audioqc (metrics.ts). Deterministic,
 * offline, diffable: files in, figures out, advisory flags mean "listen here".
 *
 * Usage: node scripts/audio-quality.ts <file.wav> [more.wav…]
 *   e.g. node scripts/audio-quality.ts data/live-sim/<epoch>/bench-heard.wav \
 *                                      data/live-sim/<epoch>/twilio-recording.wav
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { advisoryFlags, analyzeChannel, readWavChannels, renderMetrics } from '@callbench/audioqc';

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error('usage: audio-quality.ts <file.wav> [more…]');
	process.exit(1);
}
for (const f of files) {
	console.log(`\n${basename(f)} (${f})`);
	for (const ch of readWavChannels(readFileSync(f))) {
		console.log(` ${ch.label} @ ${ch.sampleRate}Hz`);
		const m = analyzeChannel(ch);
		for (const line of renderMetrics(m, advisoryFlags(m))) console.log(line);
	}
}
console.log(
	'\nAdvisory thresholds: a flag means LISTEN THERE, not "defective". Perceptual scoring ' +
		'(PESQ/ViSQOL vs the pre-wire TTS reference) is the upgrade path — maintainer call, new dependency.',
);
