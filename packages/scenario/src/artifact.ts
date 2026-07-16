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

/**
 * A reference to the run's audio recording — not the samples, which live in a
 * sibling file. The waveform is drawn CLIENT-SIDE from this file at render time
 * (ui.md: the replay pipeline measures nothing, it renders the file), so no
 * peaks are stored here. What IS stored is enough to serve the file, place it on
 * the session clock, refuse it if it drifted, and say honestly how it was made:
 *
 *   - `sha256` freezes the audio the same way the transcript hash freezes the
 *     turns — the serving route refuses a file whose bytes no longer match.
 *   - `synthetic` is provenance, not decoration. A live call's audio is a real
 *     capture (`null`); a simulator run has no microphone, so its audio is
 *     SYNTHESIZED from the turn text (e.g. `'macos-say'`) and the UI labels it as
 *     such. Calling synthesized audio a recording would be the kind of quiet
 *     fabrication the freeze invariant exists to prevent.
 */
export interface RunAudio {
	/** Filename within the run directory (served, never an absolute path). */
	readonly file: string;
	readonly sampleRate: number;
	readonly channels: number;
	readonly durationMs: number;
	/** SHA-256 of the audio file's bytes — the serving route refuses on drift. */
	readonly sha256: string;
	/** How the audio was produced. `null` = a real capture from a live call; a
	 * string names the synthesis path for a target with no real audio. */
	readonly synthetic: string | null;
}

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
	/** The run's audio recording, if any. Absent for a text-only run (the offline
	 * simulator has no audio); present for a synthesized or live-captured call. */
	readonly audio?: RunAudio;
	/**
	 * Integrity hash over everything EXCEPT the transcript (which self-verifies
	 * via its own hash). The transcript's `verifyFrozen` catches drift in the
	 * turns; without this, the FIGURES about those turns — a FAIL edited to PASS,
	 * a verdict's reasoning rewritten, a doctored `counts` — would drift silently,
	 * because the report's own `hash` is only a copy of the transcript hash, not a
	 * hash of the report body. `bodyHash` closes that: it is recomputed and
	 * refused at load, so no displayed figure (and no audio reference) can drift
	 * from what was frozen.
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
export function computeBodyHash(
	fields: Pick<
		RunArtifact,
		'artifactVersion' | 'scenario' | 'runId' | 'target' | 'createdEpochMs' | 'report' | 'audio'
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
				// `?? null` so an absent audio hashes identically to an explicit null —
				// a text-only run has one stable body hash either way.
				audio: fields.audio ?? null,
			}),
		)
		.digest('hex');
}

/**
 * Refuse a report with a duplicate assertion name across code results and judge
 * verdicts. A deep link addresses a finding by name, so a collision would make
 * one finding unreachable and point its link at the other. Enforced at BUILD and
 * re-checked at LOAD — the load boundary re-verifies every other invariant, so it
 * must not trust the writer for this one either.
 */
function assertUniqueAssertionNames(report: ScenarioReport): void {
	const names = [
		...report.results.map((r) => r.assertion),
		...report.verdicts.map((v) => v.assertion),
	];
	const dupes = names.filter((n, i) => names.indexOf(n) !== i);
	if (dupes.length > 0) {
		throw new Error(
			`refusing a run artifact: assertion name(s) collide across findings ` +
				`(${[...new Set(dupes)].join(', ')}). A deep link addresses a finding by name, so ` +
				'names must be unique across code results and judge verdicts.',
		);
	}
}

/**
 * Refuse audio whose provenance contradicts the target. A simulator has no
 * microphone, so its audio is always SYNTHESIZED (`synthetic != null`); the
 * system under test is a real line, so its audio is always a real CAPTURE
 * (`synthetic == null`). A mismatch would label a real recording as synthesized
 * or vice-versa — the exact quiet mislabel the `synthetic` tag exists to prevent.
 * Enforced at build and re-checked at load.
 */
function assertAudioCoherent(target: RunTarget, audio: RunAudio | undefined): void {
	if (!audio) return;
	if (target === 'simulator' && audio.synthetic === null) {
		throw new Error(
			'refusing a run artifact: a simulator run cannot have a real-capture recording ' +
				'(audio.synthetic is null) — the simulator has no microphone.',
		);
	}
	if (target === 'system-under-test' && audio.synthetic !== null) {
		throw new Error(
			`refusing a run artifact: a system-under-test run's audio is a real capture, but ` +
				`audio.synthetic is ${JSON.stringify(audio.synthetic)} — a synthesized recording must ` +
				'not be labeled as a real call.',
		);
	}
}

/**
 * Build a run artifact from a frozen transcript and its report. Refuses when:
 *   - the report was built over a different transcript than the one handed in (a
 *     report + transcript that disagree on their hash are not one run);
 *   - two findings share an assertion name (a deep link, which addresses a
 *     finding by name, could then never reach one of them and would mislabel the
 *     other — the path→identity guarantee, enforced at construction);
 *   - the audio's provenance contradicts the target (a mislabeled recording).
 */
export function buildRunArtifact(
	scenario: string,
	target: RunTarget,
	transcript: FrozenTranscript,
	report: ScenarioReport,
	createdEpochMs: number,
	audio?: RunAudio,
): RunArtifact {
	if (report.hash !== transcript.hash) {
		throw new Error(
			`refusing to build a run artifact: the report was computed over transcript ` +
				`${report.hash.slice(0, 12)} but the transcript hands in ${transcript.hash.slice(0, 12)}. ` +
				'A report paired with a different transcript is not one run.',
		);
	}
	assertUniqueAssertionNames(report);
	assertAudioCoherent(target, audio);
	const core = {
		artifactVersion: 1 as const,
		scenario,
		runId: runIdOf(transcript),
		target,
		createdEpochMs,
		report,
		...(audio ? { audio } : {}),
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
		audio: parsed.audio,
	});
	if (expected !== parsed.bodyHash) {
		throw new Error(
			`refusing to load run ${parsed.runId?.slice(0, 12)}: the body hash does not match. ` +
				'A figure in the report (an outcome, a verdict, a count) drifted from what was frozen.',
		);
	}
	// Re-check the invariants the writer enforced — a hand-written run.json with a
	// valid bodyHash must still not smuggle in a duplicate finding name or a
	// mislabeled recording. The load boundary trusts no writer.
	assertUniqueAssertionNames(parsed.report);
	assertAudioCoherent(parsed.target as RunTarget, parsed.audio);
	return parsed as RunArtifact;
}

/** Read and verify an artifact from `<dir>/run.json`. */
export function readRunArtifact(dir: string): RunArtifact {
	return parseRunArtifact(readFileSync(`${dir}/${RUN_FILENAME}`, 'utf8'));
}
