/**
 * Publish a frozen live take (data/live-sim/<epoch>/) as a RunArtifact the web
 * UI renders — WITHOUT placing any call. This is the record/assert split doing
 * its job: the take is already frozen; assessing and publishing are free.
 *
 * Usage: node --env-file=.env scripts/publish-live-run.ts data/live-sim/<epoch> [--judge]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeRunner, MapCache } from '@callbench/judge';
import {
	allScenarios,
	assess,
	buildRunArtifact,
	renderScenarioReport,
	runIdOf,
	writeRunArtifact,
} from '@callbench/scenario';
import type { FrozenTranscript } from '@callbench/transcript';

async function main(): Promise<void> {
	const dir = process.argv[2];
	if (!dir) throw new Error('usage: publish-live-run.ts <data/live-sim/epoch> [--judge]');
	const judge = process.argv.includes('--judge');

	const frozen = JSON.parse(readFileSync(join(dir, 'transcript.json'), 'utf8')) as FrozenTranscript;
	const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
		scenario: string;
		anchorEpochMs: number;
	};
	const wav = readFileSync(join(dir, 'bench-heard.wav'));
	const scenario = allScenarios.find((s) => s.name === meta.scenario);
	if (!scenario) throw new Error(`unknown scenario "${meta.scenario}"`);

	const report = judge
		? await assess(scenario, frozen, { runner: claudeRunner('sonnet'), cache: new MapCache() })
		: await assess({ ...scenario, judged: [] }, frozen);
	console.log(renderScenarioReport(report));

	// The audio is a REAL capture off the Twilio wire — of a call whose two
	// voices are themselves synthesized (Kokoro TTS both sides). The artifact
	// contract reserves `synthetic: null` for a target with a microphone, so
	// the provenance string carries the honest description instead.
	const durationMs = Math.round(((wav.length - 44) / 2 / 8000) * 1000);
	const artifact = buildRunArtifact(
		scenario.name,
		'simulator',
		frozen,
		report,
		meta.anchorEpochMs,
		{
			file: 'call.wav',
			sampleRate: 8000,
			channels: 1,
			durationMs,
			sha256: createHash('sha256').update(wav).digest('hex'),
			synthetic: 'live Twilio wire capture; both voices kokoro-82m over 8kHz mulaw',
		},
	);
	const runDir = join('apps', 'web', 'fixtures', 'runs', scenario.name, runIdOf(frozen));
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, 'call.wav'), wav);
	writeRunArtifact(runDir, artifact);
	console.log(`published: ${runDir}`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
