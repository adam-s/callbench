/**
 * The judge — a named, isolated stage for the assertions plain code cannot
 * express ("did it ask a *disambiguating* question", where a thousand phrasings
 * are all correct). It is fenced by three rules (architecture.md, AGENTS.md):
 *
 *   1. **Determinism comes from freezing, not from sampling.** The judge model
 *      has no temperature knob, so a re-run could return a different verdict for
 *      unchanged input. The cache prevents that: a verdict is computed once,
 *      keyed to a hash of EVERYTHING it depends on (the judged text, the rubric,
 *      the rubric version, the model), and replayed thereafter. A cache hit is
 *      offline and identical; a cache miss is the only thing that reaches the
 *      network, and it must never happen under test.
 *   2. **Recorded as judgment, not fact.** A verdict carries its rubric, the
 *      span it read, its reasoning, and the model that produced it — so a human
 *      can overrule it. Nothing downstream may treat it as ground truth.
 *   3. **Three states.** PASS / FAIL / INCONCLUSIVE, with INCONCLUSIVE a
 *      first-class answer the rubric explicitly invites — "if you cannot tell
 *      from the transcript, say INCONCLUSIVE" — so the judge abstains instead of
 *      guessing, exactly as the code assertions do.
 */

import { createHash } from 'node:crypto';
import type { Outcome, Span } from '@callbench/assert';
import type { Runner } from './runner.ts';

/** A semantic criterion the judge evaluates. `version` is part of the cache key
 * — a rubric change is a measurement change, so it must invalidate cached
 * verdicts rather than silently reuse them against the old wording. */
export interface Rubric {
	readonly name: string;
	readonly version: number;
	/** The criterion, written as a procedure the judge executes — not an
	 * adjective. Must tell the judge when to answer INCONCLUSIVE. */
	readonly criterion: string;
}

/** What the judge reads: a slice of transcript text plus the span it came from,
 * so the verdict can cite it. The caller extracts this from the frozen
 * transcript; the judge never touches the transcript object or a live call. */
export interface JudgeInput {
	readonly text: string;
	readonly span: Span;
}

/** A verdict — recorded as judgment. Everything a human needs to overrule it. */
export interface Verdict {
	readonly outcome: Outcome;
	readonly assertion: string;
	readonly reasoning: string;
	readonly span: Span | null;
	/** How this verdict was produced — judgment, not fact. */
	readonly judgedBy: string; // the runner id, e.g. claude:sonnet
	readonly rubricVersion: number;
	/** True if replayed from cache (deterministic), false if freshly computed. */
	readonly cached: boolean;
}

/** A cache of verdicts keyed by content hash. The store is injected so the
 * production store (a committed JSON file) and the test store (an in-memory
 * map pre-seeded with calibration verdicts) share one interface. */
export interface VerdictCache {
	get(key: string): StoredVerdict | undefined;
	set(key: string, verdict: StoredVerdict): void;
}

/** What's persisted — the verdict minus the `cached` flag (which is about THIS
 * lookup, not the stored value). */
export type StoredVerdict = Omit<Verdict, 'cached'>;

/**
 * The cache key: a hash over EVERYTHING the verdict depends on. Miss any
 * component and a stale verdict replays for changed input — the exact failure
 * the determinism story exists to prevent. Pinned by a mutation test.
 */
export function cacheKey(rubric: Rubric, input: JudgeInput, runnerId: string): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				rubric: rubric.criterion,
				rubricVersion: rubric.version,
				rubricName: rubric.name,
				text: input.text,
				runner: runnerId,
			}),
		)
		.digest('hex');
}

/** Build the judge prompt. The structure is the researched shape: criterion,
 * the material, an explicit reasoning instruction, and a scoring rule that
 * forces one of the three states — INCONCLUSIVE included by name. */
function buildPrompt(rubric: Rubric, input: JudgeInput): string {
	return [
		'You are grading one criterion against a transcript excerpt from a phone call.',
		'Judge only what the excerpt shows. Do not reward length or assume intent.',
		'',
		`CRITERION (${rubric.name}): ${rubric.criterion}`,
		'',
		'EXCERPT:',
		input.text,
		'',
		'Decide one verdict:',
		'- PASS: the excerpt clearly satisfies the criterion.',
		'- FAIL: the excerpt clearly violates it.',
		'- INCONCLUSIVE: the excerpt does not contain enough to tell. When you are',
		'  not sure, this is the correct answer — do not guess PASS or FAIL.',
		'',
		'Reply with ONLY a JSON object, no prose:',
		'{"verdict": "PASS" | "FAIL" | "INCONCLUSIVE", "reasoning": "<one sentence, citing the excerpt>"}',
	].join('\n');
}

/** Parse the model's reply into an outcome + reasoning. A reply that isn't the
 * expected shape is not silently coerced to a verdict — it throws, because a
 * fabricated verdict is worse than an error. */
function parseReply(reply: string): { outcome: Outcome; reasoning: string } {
	// The model may wrap the JSON in prose or fences despite instructions; find
	// the object.
	const match = /\{[\s\S]*\}/.exec(reply);
	if (!match) throw new Error(`judge reply had no JSON object: ${reply.slice(0, 120)}`);
	const parsed = JSON.parse(match[0]) as { verdict?: string; reasoning?: string };
	const v = parsed.verdict;
	if (v !== 'PASS' && v !== 'FAIL' && v !== 'INCONCLUSIVE') {
		throw new Error(`judge returned an invalid verdict: ${JSON.stringify(parsed.verdict)}`);
	}
	return { outcome: v, reasoning: parsed.reasoning ?? '(no reasoning given)' };
}

/**
 * Score one criterion. Cache first: a hit replays a frozen verdict offline and
 * marks it `cached: true`. Only a miss calls the runner — and a miss under test
 * is a bug (the suite never touches the network), which is why tests pre-seed
 * the cache and a reachable miss is itself the finding.
 */
export async function judge(
	rubric: Rubric,
	input: JudgeInput,
	runner: Runner,
	cache: VerdictCache,
): Promise<Verdict> {
	const key = cacheKey(rubric, input, runner.id);
	const hit = cache.get(key);
	if (hit) return { ...hit, cached: true };

	const reply = await runner.run(buildPrompt(rubric, input));
	const { outcome, reasoning } = parseReply(reply);
	const stored: StoredVerdict = {
		outcome,
		assertion: rubric.name,
		reasoning,
		// A verdict cites its span only when it reached a conclusion about the
		// excerpt; an INCONCLUSIVE points at nothing, like the code assertions.
		span: outcome === 'INCONCLUSIVE' ? null : input.span,
		judgedBy: runner.id,
		rubricVersion: rubric.version,
	};
	cache.set(key, stored);
	return { ...stored, cached: false };
}

/** A trivial in-memory cache — the shape tests use, and a fine default. The
 * production cache is a committed JSON file loaded into this same interface. */
export class MapCache implements VerdictCache {
	readonly #map = new Map<string, StoredVerdict>();
	constructor(seed: Record<string, StoredVerdict> = {}) {
		for (const [k, v] of Object.entries(seed)) this.#map.set(k, v);
	}
	get(key: string): StoredVerdict | undefined {
		return this.#map.get(key);
	}
	set(key: string, verdict: StoredVerdict): void {
		this.#map.set(key, verdict);
	}
}
