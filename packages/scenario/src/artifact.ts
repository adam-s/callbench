/**
 * The run artifact — the frozen record of one scenario run, persisted to disk so
 * the two phases stay separate programs (architecture.md): the runner writes it
 * once; the UI (a third program) reads it many times and never re-runs the call.
 *
 * The artifact is the ONLY thing the UI sees. It carries the frozen transcript,
 * the report computed over it, which target produced it (the fence below reads
 * this), and when. Loading re-verifies the transcript hash and REFUSES on a
 * mismatch — the same refuse-on-drift gate the report enforces, now at the read
 * boundary, so a drifted file on disk cannot be rendered as evidence.
 *
 * The `target` tag is load-bearing to the product's central safety fence: a run
 * against the simulator may be replayed and re-run freely (nobody's line rings);
 * a run against the system under test may only ever be VIEWED. The UI decides
 * whether a play/re-run control exists by reading this field — but the deeper
 * guarantee is structural (no dial path is built at all), not a check here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { type FrozenTranscript, verifyFrozen } from '@callbench/transcript';
import type { ScenarioReport } from './scenario.ts';

/** Which system produced a run. The simulator is ours on both ends; the system
 * under test is a stranger's live line. The distinction gates every interactive
 * control in the UI, so it travels WITH the record rather than being inferred. */
export type RunTarget = 'simulator' | 'system-under-test';

export interface RunArtifact {
	/** Contract version — bumped if this shape changes, so a reader can refuse an
	 * artifact it does not understand rather than mis-parse it. */
	readonly artifactVersion: 1;
	/** The scenario's stable name. */
	readonly scenario: string;
	/** This run's identifier — the frozen transcript's hash. A run IS its
	 * evidence, so its id is a hash of that evidence; two runs with the same id
	 * are the same call, and a URL naming a run keeps naming the same one. */
	readonly runId: string;
	/** What produced the call — the fence reads this. */
	readonly target: RunTarget;
	/** The frozen, hashed transcript. */
	readonly transcript: FrozenTranscript;
	/** The report computed over that transcript (code results + judge verdicts). */
	readonly report: ScenarioReport;
	/** Wall-clock epoch when the run was recorded. */
	readonly createdEpochMs: number;
	/**
	 * Integrity hash over everything EXCEPT the transcript (which self-verifies
	 * via its own hash). The transcript's `verifyFrozen` catches drift in the
	 * turns; without this, the FIGURES about those turns — a FAIL edited to PASS,
	 * a verdict's reasoning rewritten, a doctored `counts` — would drift silently,
	 * because the report's own `hash` is only a copy of the transcript hash, not a
	 * hash of the report body. `bodyHash` closes that: it is recomputed and
	 * refused at load, so no displayed figure can drift from what was frozen.
	 */
	readonly bodyHash: string;
}

/** The canonical filename for a run's artifact within its run directory. */
export const RUN_FILENAME = 'run.json';

/** Derive a run id from a frozen transcript — its hash. Single-sourced here so
 * the writer and any id-based lookup agree. */
export function runIdOf(transcript: FrozenTranscript): string {
	return transcript.hash;
}

/**
 * The body-integrity hash: everything the artifact asserts EXCEPT the transcript
 * (which self-verifies via its own hash). Computed over an explicit, fixed-order
 * object so build-time and load-time agree; `bodyHash` itself is excluded (it
 * cannot hash itself). Recomputed and refused at load — see parseRunArtifact.
 */
function computeBodyHash(
	fields: Pick<
		RunArtifact,
		'artifactVersion' | 'scenario' | 'runId' | 'target' | 'createdEpochMs' | 'report'
	>,
): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				artifactVersion: fields.artifactVersion,
				scenario: fields.scenario,
				runId: fields.runId,
				target: fields.target,
				createdEpochMs: fields.createdEpochMs,
				report: fields.report,
			}),
		)
		.digest('hex');
}

/** Every assertion name that appears in a report — code results then verdicts.
 * A deep link addresses a finding by this name, so the names must be unique
 * across BOTH seams; a collision would make one finding unreachable and point a
 * link at the wrong evidence. `buildRunArtifact` enforces that here. */
function assertionNames(report: ScenarioReport): string[] {
	return [...report.results.map((r) => r.assertion), ...report.verdicts.map((v) => v.assertion)];
}

/**
 * Build a run artifact from a frozen transcript and its report. Refuses when:
 *   - the report was built over a different transcript than the one handed in (a
 *     report + transcript that disagree on their hash are not one run);
 *   - two findings share an assertion name (a deep link, which addresses a
 *     finding by name, could then never reach one of them and would mislabel the
 *     other — the path→identity guarantee, enforced at construction).
 */
export function buildRunArtifact(
	scenario: string,
	target: RunTarget,
	transcript: FrozenTranscript,
	report: ScenarioReport,
	createdEpochMs: number,
): RunArtifact {
	if (report.hash !== transcript.hash) {
		throw new Error(
			`refusing to build a run artifact: the report was computed over transcript ` +
				`${report.hash.slice(0, 12)} but the transcript hands in ${transcript.hash.slice(0, 12)}. ` +
				'A report paired with a different transcript is not one run.',
		);
	}
	const names = assertionNames(report);
	const dupes = names.filter((n, i) => names.indexOf(n) !== i);
	if (dupes.length > 0) {
		throw new Error(
			`refusing to build a run artifact: assertion name(s) collide across findings ` +
				`(${[...new Set(dupes)].join(', ')}). A deep link addresses a finding by name, so ` +
				'names must be unique across code results and judge verdicts.',
		);
	}
	const core = {
		artifactVersion: 1 as const,
		scenario,
		runId: runIdOf(transcript),
		target,
		createdEpochMs,
		report,
	};
	return { ...core, transcript, bodyHash: computeBodyHash(core) };
}

/** Serialize an artifact to its canonical JSON text (stable key order via the
 * object literal above; pretty-printed so a committed fixture diffs cleanly). */
export function serializeRunArtifact(artifact: RunArtifact): string {
	return `${JSON.stringify(artifact, null, '\t')}\n`;
}

/** Write an artifact to `<dir>/run.json`. Returns the path written. */
export function writeRunArtifact(dir: string, artifact: RunArtifact): string {
	const path = `${dir}/${RUN_FILENAME}`;
	writeFileSync(path, serializeRunArtifact(artifact));
	return path;
}

/**
 * Parse and VERIFY a run artifact. Every refusal below is load-bearing; a
 * parsed-but-unverified artifact is never returned:
 *   - the top-level shape is present (a file missing `transcript`/`report`
 *     refuses with the designed message, not a raw dereference TypeError);
 *   - an unknown `artifactVersion` is refused, not coerced;
 *   - the transcript is re-hashed and refused on drift from its turns;
 *   - the report's hash must match the transcript it is stored with;
 *   - the BODY hash must match — so no displayed figure (an outcome, a verdict's
 *     reasoning, a count) can drift from what was frozen while the transcript
 *     still verifies.
 */
export function parseRunArtifact(text: string): RunArtifact {
	const parsed = JSON.parse(text) as Partial<RunArtifact>;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('refusing to load a run artifact: the file is not a JSON object.');
	}
	if (parsed.artifactVersion !== 1) {
		throw new Error(
			`refusing to load a run artifact with unknown version ${JSON.stringify(
				(parsed as { artifactVersion?: unknown }).artifactVersion,
			)}; this reader understands version 1.`,
		);
	}
	if (!parsed.transcript || !parsed.report || typeof parsed.bodyHash !== 'string') {
		throw new Error(
			'refusing to load a run artifact: it is missing a transcript, report, or bodyHash — ' +
				'the file is not a well-formed run.',
		);
	}
	if (!verifyFrozen(parsed.transcript)) {
		throw new Error(
			`refusing to load run ${parsed.runId?.slice(0, 12)}: the transcript hash does not match ` +
				'its turns. The artifact on disk drifted from what was frozen; rendering it would ' +
				'publish a figure that no longer describes the call.',
		);
	}
	if (parsed.report.hash !== parsed.transcript.hash) {
		throw new Error(
			`refusing to load run ${parsed.runId?.slice(0, 12)}: the report's hash does not match ` +
				'the transcript it is stored with.',
		);
	}
	const expected = computeBodyHash({
		artifactVersion: parsed.artifactVersion,
		scenario: parsed.scenario as string,
		runId: parsed.runId as string,
		target: parsed.target as RunTarget,
		createdEpochMs: parsed.createdEpochMs as number,
		report: parsed.report,
	});
	if (expected !== parsed.bodyHash) {
		throw new Error(
			`refusing to load run ${parsed.runId?.slice(0, 12)}: the body hash does not match. ` +
				'A figure in the report (an outcome, a verdict, a count) drifted from what was frozen.',
		);
	}
	return parsed as RunArtifact;
}

/** Read and verify an artifact from `<dir>/run.json`. */
export function readRunArtifact(dir: string): RunArtifact {
	return parseRunArtifact(readFileSync(`${dir}/${RUN_FILENAME}`, 'utf8'));
}

/** A hash over an artifact's serialized bytes — a fixture test can pin the whole
 * file, so a change to any figure in a committed run fails loudly. */
export function artifactDigest(artifact: RunArtifact): string {
	return createHash('sha256').update(serializeRunArtifact(artifact)).digest('hex');
}
