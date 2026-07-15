/**
 * Run-artifact tests — the read boundary the UI depends on. What's pinned:
 *   - a round-trip (build → serialize → parse) preserves the run;
 *   - loading REFUSES a transcript whose hash drifted from its turns;
 *   - loading REFUSES an unknown artifact version rather than mis-parsing it;
 *   - building REFUSES a report paired with a different transcript;
 *   - the target tag (the fence's input) survives the round-trip.
 * All offline — the artifact is exactly what keeps the UI off the live call.
 */

import { MapCache, type Runner } from '@callbench/judge';
import { describe, expect, it } from 'vitest';
import {
	buildRunArtifact,
	parseRunArtifact,
	type RunArtifact,
	serializeRunArtifact,
} from '../artifact.ts';
import { assess, driveSimulator } from '../scenario.ts';
import { windshieldQuote } from '../scenarios.ts';

const scriptedRunner: Runner = {
	id: 'scripted:test',
	run: () => Promise.resolve(JSON.stringify({ verdict: 'PASS', reasoning: 'fixture' })),
};

async function makeArtifact(): Promise<RunArtifact> {
	const transcript = driveSimulator(windshieldQuote);
	const report = await assess(windshieldQuote, transcript, {
		runner: scriptedRunner,
		cache: new MapCache(),
	});
	return buildRunArtifact('windshield-quote', 'simulator', transcript, report, 1_784_000_100_000);
}

describe('run artifact round-trip', () => {
	it('build → serialize → parse preserves the run and its target tag', async () => {
		const artifact = await makeArtifact();
		const back = parseRunArtifact(serializeRunArtifact(artifact));
		expect(back.scenario).toBe('windshield-quote');
		expect(back.target).toBe('simulator'); // the fence's input survives
		expect(back.runId).toBe(artifact.transcript.hash);
		expect(back.report.counts).toEqual(artifact.report.counts);
	});
});

describe('loading refuses drifted or unknown artifacts', () => {
	it('refuses a transcript whose hash no longer matches its turns', async () => {
		const artifact = await makeArtifact();
		// Drop a turn but keep the stored hash — the on-disk drift the gate exists for.
		const drifted = {
			...artifact,
			transcript: { ...artifact.transcript, turns: artifact.transcript.turns.slice(1) },
		};
		expect(() => parseRunArtifact(JSON.stringify(drifted))).toThrow(/does not match its turns/);
	});

	it('refuses an unknown artifact version rather than mis-parsing it', async () => {
		const artifact = await makeArtifact();
		const future = { ...artifact, artifactVersion: 2 };
		expect(() => parseRunArtifact(JSON.stringify(future))).toThrow(/unknown version/);
	});

	it("refuses a report whose hash doesn't match the transcript it's stored with", async () => {
		const artifact = await makeArtifact();
		const mismatched = {
			...artifact,
			report: { ...artifact.report, hash: 'deadbeef' },
		};
		expect(() => parseRunArtifact(JSON.stringify(mismatched))).toThrow(
			/does not match the transcript/,
		);
	});

	it('refuses when a FIGURE in the report is edited but the transcript still verifies (body drift)', async () => {
		const artifact = await makeArtifact();
		// Flip a result's outcome — the transcript is untouched, so verifyFrozen
		// still passes and report.hash still equals it; only the body hash catches
		// this. This is the tamper the transcript hash alone could not see.
		const tampered = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
		const first = tampered.report.results[0] as { outcome: string };
		first.outcome = first.outcome === 'PASS' ? 'FAIL' : 'PASS';
		expect(() => parseRunArtifact(JSON.stringify(tampered))).toThrow(/body hash does not match/);
	});

	it('refuses an artifact missing bodyHash entirely (not a well-formed run)', async () => {
		const artifact = await makeArtifact();
		const { bodyHash, ...withoutHash } = artifact;
		void bodyHash;
		expect(() => parseRunArtifact(JSON.stringify(withoutHash))).toThrow(/not a well-formed run/);
	});
});

describe('building refuses colliding assertion names (path→identity)', () => {
	it('throws when a code result and a judge verdict share an assertion name', async () => {
		const transcript = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, transcript, {
			runner: scriptedRunner,
			cache: new MapCache(),
		});
		// Force a collision: rename every verdict to a code result's name.
		const clashName = report.results[0]!.assertion;
		const collided = {
			...report,
			verdicts: report.verdicts.map((v) => ({ ...v, assertion: clashName })),
		};
		expect(() =>
			buildRunArtifact('windshield-quote', 'simulator', transcript, collided, 1),
		).toThrow(/collide/);
	});
});

describe('building refuses a mismatched report/transcript pair', () => {
	it('throws when the report was computed over a different transcript', async () => {
		const transcript = driveSimulator(windshieldQuote);
		const other = driveSimulator(windshieldQuote, {
			fabricateCamera: true,
			dropCorrection: false,
			goSilentAtQuote: false,
		});
		const report = await assess(windshieldQuote, other, {
			runner: scriptedRunner,
			cache: new MapCache(),
		});
		// report describes `other`, but we hand in `transcript` — different hash.
		expect(() => buildRunArtifact('windshield-quote', 'simulator', transcript, report, 1)).toThrow(
			/not one run/,
		);
	});
});
