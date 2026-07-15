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
	computeBodyHash,
	parseRunArtifact,
	type RunArtifact,
	type RunAudio,
	serializeRunArtifact,
} from '../artifact.ts';
import { assess, driveSimulator } from '../scenario.ts';
import { windshieldQuote } from '../scenarios.ts';

const REAL_AUDIO: RunAudio = {
	file: 'call.wav',
	sampleRate: 8000,
	channels: 1,
	durationMs: 1000,
	sha256: 'a'.repeat(64),
	synthetic: null,
};
const SYNTH_AUDIO: RunAudio = { ...REAL_AUDIO, synthetic: 'macos-say' };

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

	it('refuses when the AUDIO reference is edited (audio is covered by the body hash)', async () => {
		const transcript = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, transcript, {
			runner: scriptedRunner,
			cache: new MapCache(),
		});
		const withAudio = buildRunArtifact('windshield-quote', 'simulator', transcript, report, 1, {
			file: 'call.wav',
			sampleRate: 8000,
			channels: 1,
			durationMs: 12345,
			sha256: 'a'.repeat(64),
			synthetic: 'macos-say',
		});
		// The clean artifact loads.
		expect(() => parseRunArtifact(serializeRunArtifact(withAudio))).not.toThrow();
		// Point the audio at a different file / hash — a swap the transcript hash
		// can't see. Only the body hash catches it.
		const tampered = JSON.parse(serializeRunArtifact(withAudio)) as typeof withAudio;
		(tampered.audio as { sha256: string }).sha256 = 'b'.repeat(64);
		expect(() => parseRunArtifact(JSON.stringify(tampered))).toThrow(/body hash does not match/);
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

describe('audio provenance must match the target — no mislabeled recording', () => {
	it('build refuses a simulator run with a real-capture recording (synthetic null)', async () => {
		const t = driveSimulator(windshieldQuote);
		const r = await assess(windshieldQuote, t, { runner: scriptedRunner, cache: new MapCache() });
		expect(() => buildRunArtifact('windshield-quote', 'simulator', t, r, 1, REAL_AUDIO)).toThrow(
			/simulator/,
		);
	});

	it('build refuses a system-under-test run whose audio is synthesized', async () => {
		const t = driveSimulator(windshieldQuote);
		const r = await assess(windshieldQuote, t, { runner: scriptedRunner, cache: new MapCache() });
		// A system-under-test run legitimately has real audio, so build it with that,
		// then the synthesized variant must be refused.
		expect(() =>
			buildRunArtifact('windshield-quote', 'system-under-test', t, r, 1, SYNTH_AUDIO),
		).toThrow(/system-under-test/);
	});
});

describe('the load boundary re-checks what the writer enforced (forged valid bodyHash)', () => {
	// A hand-written run.json can carry a VALID bodyHash for malicious content —
	// the load boundary must not trust the writer. Forge such a file with the
	// exported hash primitive and confirm parse still refuses.
	async function forge(mutate: (a: RunArtifact) => RunArtifact): Promise<string> {
		const artifact = await makeArtifact();
		const bad = mutate(structuredClone(artifact));
		const core = {
			artifactVersion: bad.artifactVersion,
			scenario: bad.scenario,
			runId: bad.runId,
			target: bad.target,
			createdEpochMs: bad.createdEpochMs,
			report: bad.report,
			audio: bad.audio,
		};
		return JSON.stringify({ ...bad, bodyHash: computeBodyHash(core) });
	}

	it('refuses a duplicate assertion name even with a matching bodyHash', async () => {
		const text = await forge((a) => {
			const name = a.report.results[0]!.assertion;
			return {
				...a,
				report: {
					...a.report,
					verdicts: a.report.verdicts.map((v) => ({ ...v, assertion: name })),
				},
			};
		});
		expect(() => parseRunArtifact(text)).toThrow(/collide/);
	});

	it('refuses a mislabeled recording even with a matching bodyHash', async () => {
		// makeArtifact is a simulator run; give it a real-capture (synthetic null)
		// audio ref — incoherent, and the load re-check must catch it.
		const text = await forge((a) => ({ ...a, audio: REAL_AUDIO }));
		expect(() => parseRunArtifact(text)).toThrow(/simulator/);
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
