/**
 * The transcript — the architectural center (architecture.md). Everything else
 * is replaceable around it; this is the frozen artifact assertions read and the
 * report cites.
 *
 * The five properties it must hold, and how each is enforced here:
 *
 *   - **append-only** — `append` is the only mutator, and it throws after
 *     `freeze`. There is no edit, no delete, no reorder.
 *   - **verbatim** — a turn stores exactly what was said (`text`), never a
 *     summary. Nothing in this module rewrites it.
 *   - **one clock, one layer** — every `startMs`/`endMs` is on the session's
 *     own monotonic axis (the transport contract's `atMs`), stamped at one
 *     layer. This module does not read a clock; it stores the stamps it is
 *     given, so a caller mixing clocks is the caller's bug, flagged loudly by
 *     the ordering check on append.
 *   - **hashed and frozen** — `freeze` canonicalizes and SHA-256s the turns,
 *     returning an immutable artifact carrying that hash. A report refuses on a
 *     hash mismatch, so a figure can never drift from the call it describes.
 *   - **the only input to assertions** — assertions read `FrozenTranscript`,
 *     never a live call. Confidence and provider travel WITH each turn, so a
 *     later stage never re-derives identity from a provider quirk.
 */

import { createHash } from 'node:crypto';

/** Who produced this turn. `bench` is us; `target` is the system under test. */
export type Speaker = 'bench' | 'target';

/**
 * The speech-to-text confidence for a heard turn — the foundation INCONCLUSIVE
 * is built on (plan.md, Increment 2). Null for a turn the bench itself spoke:
 * we know verbatim what we synthesized, so there is nothing to be unsure about.
 * The raw provider fields travel unchanged; the abstain threshold is the
 * assertion layer's decision, never baked in here.
 */
export interface Confidence {
	/** Mean token log-probability. Near 0 = confident; very negative = unsure. */
	readonly avgLogprob: number;
	/** Probability the segment was not speech at all. High = probably silence. */
	readonly noSpeechProb: number;
	/** The least-confident word's probability — the weakest link in the turn. */
	readonly minWordProb: number;
}

export interface Turn {
	readonly speaker: Speaker;
	/** Verbatim. What was said, not a summary. */
	readonly text: string;
	/** Session-clock milliseconds (transport `atMs`), one layer. */
	readonly startMs: number;
	readonly endMs: number;
	/** STT confidence for a heard turn; null for a turn the bench spoke. */
	readonly confidence: Confidence | null;
	/** Identity travels with the record: e.g. `faster-whisper:large-v3`, or
	 * `scripted` for a bench utterance the scenario supplied verbatim. */
	readonly provider: string;
}

export interface FrozenTranscript {
	readonly turns: readonly Turn[];
	/** SHA-256 over the canonical serialization of `turns`. */
	readonly hash: string;
	/** Wall-clock epoch at the session's `atMs = 0`, carried from the
	 * transport session so the record can be placed in calendar time. */
	readonly anchorEpochMs: number;
}

/** Canonical bytes for hashing: field order fixed, no incidental whitespace, so
 * the same turns always hash the same regardless of how they were built. */
function canonicalize(turns: readonly Turn[], anchorEpochMs: number): string {
	return JSON.stringify({
		anchorEpochMs,
		turns: turns.map((t) => ({
			speaker: t.speaker,
			text: t.text,
			startMs: t.startMs,
			endMs: t.endMs,
			confidence: t.confidence
				? {
						avgLogprob: t.confidence.avgLogprob,
						noSpeechProb: t.confidence.noSpeechProb,
						minWordProb: t.confidence.minWordProb,
					}
				: null,
			provider: t.provider,
		})),
	});
}

/** Compute the frozen hash of a set of turns — the same function `freeze` uses
 * and the function a report uses to REFUSE on mismatch. Exposed so the refusal
 * check and the freeze share one definition and can never drift apart. */
export function hashTurns(turns: readonly Turn[], anchorEpochMs: number): string {
	return createHash('sha256').update(canonicalize(turns, anchorEpochMs)).digest('hex');
}

/**
 * A growing transcript. Append turns during a call; freeze once at the end.
 * After freeze it is immutable and further appends throw — the append-only
 * invariant, enforced rather than trusted.
 */
export class Transcript {
	readonly #turns: Turn[] = [];
	readonly #anchorEpochMs: number;
	#frozen: FrozenTranscript | null = null;

	constructor(anchorEpochMs: number) {
		this.#anchorEpochMs = anchorEpochMs;
	}

	/** Append one turn. Throws after freeze, and throws if the turn's span
	 * starts before the previous turn's — out-of-order stamps mean the caller
	 * mixed clocks or layers, which the transcript refuses rather than records
	 * silently (the whole point of one-clock-one-layer). */
	append(turn: Turn): void {
		if (this.#frozen) {
			throw new Error('transcript is frozen; it is append-only and the call has ended');
		}
		if (turn.endMs < turn.startMs) {
			throw new Error(`turn ends before it starts (${turn.startMs}..${turn.endMs}ms)`);
		}
		const prev = this.#turns.at(-1);
		if (prev && turn.startMs < prev.startMs) {
			throw new Error(
				`turn starts at ${turn.startMs}ms, before the previous turn's ${prev.startMs}ms — ` +
					'out-of-order stamps mean mixed clocks or layers',
			);
		}
		this.#turns.push(turn);
	}

	/** The turns so far — a copy, so a caller cannot mutate the record. */
	get turns(): readonly Turn[] {
		return [...this.#turns];
	}

	get frozen(): boolean {
		return this.#frozen !== null;
	}

	/** Freeze and hash. Idempotent: freezing twice returns the same artifact. */
	freeze(): FrozenTranscript {
		if (this.#frozen) return this.#frozen;
		const turns = [...this.#turns];
		this.#frozen = {
			turns,
			hash: hashTurns(turns, this.#anchorEpochMs),
			anchorEpochMs: this.#anchorEpochMs,
		};
		return this.#frozen;
	}
}

/** Verify a frozen artifact against its own turns — the report's refuse-on-
 * mismatch gate. Returns true only if the stored hash still matches the turns,
 * so a report can refuse to publish a figure that has drifted from its record. */
export function verifyFrozen(artifact: FrozenTranscript): boolean {
	return hashTurns(artifact.turns, artifact.anchorEpochMs) === artifact.hash;
}
