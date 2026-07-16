/**
 * The scenario — the authoring surface a QA tester writes against, and the seam
 * that joins the two phases of the bench (architecture.md's record/assert split)
 * into one runnable object:
 *
 *   1. **Record.** A scenario names an ordered sequence of caller turns, some of
 *      them marked as probe injections. `driveSimulator` plays that sequence
 *      into the target simulator and freezes the exchange as a transcript — the
 *      offline stand-in for a live call. (The live driver, which speaks the same
 *      caller turns over transport/STT/TTS, is a later increment; it produces
 *      the same FrozenTranscript, so `assess` below never learns which one ran.)
 *   2. **Assert.** `assess` runs the scenario's assertions over that frozen
 *      transcript. Two kinds live side by side: CODE assertions (plain
 *      deterministic functions, @callbench/assert) and JUDGED assertions (a
 *      rubric scored by the judge seam, @callbench/judge) for the irreducibly
 *      semantic checks. They resolve into one report with one set of counts.
 *
 * The two kinds are kept in SEPARATE arrays in the report, not merged into a
 * uniform list. A code Result and a judge Verdict are structurally close, but a
 * Verdict carries provenance a Result does not — the model that produced it, the
 * rubric version, whether it was replayed from cache. Flattening a Verdict into
 * a Result would drop exactly the fields that make it "recorded as judgment, not
 * fact" (AGENTS.md), so the seam stays visible in the report's shape.
 */

import { type Assertion, type Outcome, type Result, runAssertions } from '@callbench/assert';
import {
	type JudgeInput,
	judge,
	type Rubric,
	type Runner,
	type Verdict,
	type VerdictCache,
} from '@callbench/judge';
import {
	type Defects,
	INITIAL_MEMORY,
	NO_DEFECTS,
	type SimMemory,
	type SimScript,
	step,
} from '@callbench/simulator';
import {
	type Confidence,
	type FrozenTranscript,
	Transcript,
	verifyFrozen,
} from '@callbench/transcript';

/**
 * One caller turn. A bare string is a line the bench speaks; the object form
 * marks the line as a PROBE injection and names it, so a finding can trace back
 * to the probe that provoked it and a later live persona can be made to inject
 * the probe verbatim regardless of what a model would otherwise say. The label
 * is provenance only — the offline simulator reads `say` either way.
 */
export type CallerTurn = string | { readonly say: string; readonly probe: string };

function said(turn: CallerTurn): string {
	return typeof turn === 'string' ? turn : turn.say;
}

/**
 * A judged assertion: a rubric plus how to extract the excerpt the judge reads.
 * `extract` returns null when the transcript does not contain the material the
 * rubric needs (the flow never reached the probe point) — the judged assertion
 * then abstains to INCONCLUSIVE WITHOUT consulting the model, exactly as a code
 * assertion abstains rather than guess. This is the only correct way to reach
 * INCONCLUSIVE for a judged assertion structurally; the model itself may also
 * answer INCONCLUSIVE from material that is present but insufficient.
 */
export interface JudgedAssertion {
	readonly rubric: Rubric;
	readonly extract: (transcript: FrozenTranscript) => JudgeInput | null;
}

export interface Scenario {
	/** Stable name — the same string across runs, so a scenario's report can be
	 * tracked and diffed run over run. */
	readonly name: string;
	/** Ordered caller turns, some marked as probe injections. */
	readonly caller: readonly CallerTurn[];
	/** The practice target's script — what the simulator says for THIS
	 * scenario's vehicle, built from its fact set (scriptFromFactSet). The
	 * engine is vehicle-blind; the scenario carries the vehicle, which is what
	 * lets any make/model/year rehearse against the same simulator. */
	readonly simScript: SimScript;
	/** Optional turn-detector overrides for the live driver — scenario DATA,
	 * because pause behavior belongs to the LINES: a number- or list-heavy
	 * caller pauses longer mid-utterance ("It's a 2015 … Audi … A3"), so such
	 * a scenario widens the confirm window instead of every scenario paying
	 * the latency. Keys mirror @callbench/turn's TurnDetectorConfig. */
	readonly turnConfig?: Readonly<
		Partial<
			Record<'provisionalSilenceMs' | 'confirmSilenceMs' | 'minSpeechMs' | 'speechEnergy', number>
		>
	>;
	/** Deterministic code assertions over the frozen transcript. */
	readonly assertions: readonly Assertion[];
	/** Semantic assertions scored by the judge. Optional — a scenario may be
	 * fully checkable in code, and code is preferred every time it suffices. */
	readonly judged?: readonly JudgedAssertion[];
}

/** What the judge stage needs, injected so the suite runs against a seeded cache
 * and never a live model (the network stays out of the suite). */
export interface JudgeContext {
	readonly runner: Runner;
	readonly cache: VerdictCache;
}

/** A judged assertion that abstained structurally — the harness, not the model,
 * decided there was nothing to judge. `judgedBy` says so honestly rather than
 * crediting a model that never ran. */
const HARNESS = 'harness';

export interface ScenarioReport {
	readonly scenario: string;
	readonly hash: string;
	/** Counts across BOTH code results and judge verdicts — an outcome is an
	 * outcome regardless of which seam produced it. */
	readonly counts: Readonly<Record<Outcome, number>>;
	/** Code assertion results. */
	readonly results: readonly Result[];
	/** Judge verdicts — kept separate, carrying full provenance (judgment, not
	 * fact). Empty when the scenario has no judged assertions. */
	readonly verdicts: readonly Verdict[];
}

/** Confidence for a target turn the offline simulator "spoke" — the simulator is
 * a text state machine with no audio, so its turns are heard perfectly. A live
 * driver replaces this with the STT adapter's real per-turn confidence, which is
 * what lets an assertion abstain; the offline path deliberately never abstains
 * for clarity, so a defect-driven FAIL is unambiguous. */
const SIMULATOR_CLEAR: Confidence = { score: 1, raw: { simulator: 1 } };

/**
 * RECORD (offline). Play the scenario's caller turns into the target simulator
 * and freeze the exchange. Bench turns carry what the caller said (provider
 * `scripted`, no confidence — we know verbatim what we synthesized); target
 * turns carry the simulator's replies. The clock is a plain per-turn increment
 * on one axis — the simulator has no real timing, and the transcript's one-clock
 * ordering check still holds because every stamp comes from this single source.
 *
 * `defects` toggles the simulator's deliberate bugs so a scenario can be watched
 * failing; `turnMs` is the fixed span each turn occupies on the synthetic clock.
 * `heardConfidence` overrides the (perfect) confidence stamped on target turns —
 * the offline stand-in for a poorly-heard turn, so the clarity-floor abstention
 * a live call would hit can be exercised without a real STT layer.
 */
export function driveSimulator(
	scenario: Scenario,
	defects: Defects = NO_DEFECTS,
	opts: {
		readonly anchorEpochMs?: number;
		readonly turnMs?: number;
		readonly heardConfidence?: Confidence;
	} = {},
): FrozenTranscript {
	const anchorEpochMs = opts.anchorEpochMs ?? 1_784_000_000_000;
	const turnMs = opts.turnMs ?? 1000;
	const heardConfidence = opts.heardConfidence ?? SIMULATOR_CLEAR;
	const transcript = new Transcript(anchorEpochMs);
	let memory: SimMemory = INITIAL_MEMORY;
	let clock = 0;

	for (const turn of scenario.caller) {
		const line = said(turn);
		transcript.append({
			speaker: 'bench',
			text: line,
			startMs: clock,
			endMs: clock + turnMs,
			confidence: null,
			provider: 'scripted',
		});
		clock += turnMs;

		const reply = step(memory, line, defects, scenario.simScript);
		memory = reply.memory;
		// A null reply is deliberate silence (goSilentAtQuote) — a real behavior,
		// recorded as the absence of a target turn, not a fabricated one.
		if (reply.say !== null) {
			transcript.append({
				speaker: 'target',
				text: reply.say,
				startMs: clock,
				endMs: clock + turnMs,
				confidence: heardConfidence,
				provider: 'simulator',
			});
			clock += turnMs;
		}
	}
	return transcript.freeze();
}

/**
 * ASSERT. Run the scenario's assertions over a frozen transcript and build the
 * report. Refuses (throws) on a hash mismatch before doing anything — a drifted
 * record does not get a report (AGENTS.md), the same gate the code-only report
 * enforces.
 *
 * Code assertions run first (free, deterministic). Judged assertions run only if
 * the scenario has any; a scenario with judged assertions but no `judge` context
 * is a caller error, thrown loudly rather than silently skipping the checks.
 */
export async function assess(
	scenario: Scenario,
	transcript: FrozenTranscript,
	judgeCtx?: JudgeContext,
): Promise<ScenarioReport> {
	if (!verifyFrozen(transcript)) {
		throw new Error(
			`refusing to assess scenario "${scenario.name}": the transcript hash does not match ` +
				'its turns. The record drifted from what was frozen; a finding from it would be a lie.',
		);
	}

	const results = runAssertions(transcript, scenario.assertions);

	const judged = scenario.judged ?? [];
	const verdicts: Verdict[] = [];
	if (judged.length > 0) {
		if (!judgeCtx) {
			throw new Error(
				`scenario "${scenario.name}" has ${judged.length} judged assertion(s) but no judge ` +
					'context was supplied; refusing to skip them silently.',
			);
		}
		for (const j of judged) {
			const input = j.extract(transcript);
			if (input === null) {
				// Structural abstention: the excerpt the rubric needs was not available
				// — absent, or present but heard too poorly to trust (the extractor
				// applies the same clarity floor the code assertions do). The harness
				// decided this, not the model — say so, and never consult the model for
				// a question the transcript cannot answer.
				verdicts.push({
					outcome: 'INCONCLUSIVE',
					assertion: j.rubric.name,
					reasoning:
						'the excerpt this rubric needs was not available (absent or heard below the clarity floor)',
					span: null,
					judgedBy: HARNESS,
					rubricVersion: j.rubric.version,
					cached: false,
				});
				continue;
			}
			verdicts.push(await judge(j.rubric, input, judgeCtx.runner, judgeCtx.cache));
		}
	}

	const counts: Record<Outcome, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
	for (const r of results) counts[r.outcome]++;
	for (const v of verdicts) counts[v.outcome]++;

	return { scenario: scenario.name, hash: transcript.hash, counts, results, verdicts };
}

/** Render a scenario report as diffable text: counts first (the headline), then
 * code results, then judge verdicts tagged with the model that produced them so
 * a reader never mistakes a judgment for a measured fact. */
export function renderScenarioReport(report: ScenarioReport): string {
	const { counts } = report;
	const lines: string[] = [
		`scenario ${report.scenario}`,
		`transcript ${report.hash.slice(0, 16)}`,
		`PASS ${counts.PASS}  FAIL ${counts.FAIL}  INCONCLUSIVE ${counts.INCONCLUSIVE}`,
		'',
	];
	for (const r of report.results) {
		const where = r.span
			? `@turn ${r.span.turnIndex} [${r.span.startMs}-${r.span.endMs}ms]`
			: '(no span reached)';
		lines.push(`${r.outcome.padEnd(12)} ${r.assertion}  ${where}`);
		lines.push(`             ${r.detail}`);
	}
	for (const v of report.verdicts) {
		const where = v.span
			? `@turn ${v.span.turnIndex} [${v.span.startMs}-${v.span.endMs}ms]`
			: '(no span)';
		lines.push(
			`${v.outcome.padEnd(12)} ${v.assertion}  ${where}  [judged by ${v.judgedBy}${v.cached ? ', cached' : ''}]`,
		);
		lines.push(`             ${v.reasoning}`);
	}
	return lines.join('\n');
}
