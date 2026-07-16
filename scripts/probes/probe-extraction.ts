/**
 * Extraction probe — does a model read a target turn into the typed record
 * docs/diagnosis.md specifies, well enough for deterministic code to reach the
 * right outcome?
 *
 * This is a PROBE, not a test. It touches the network, so it never runs in the
 * gate (AGENTS.md: the suite never touches the network; live-network scripts
 * stay deliberate). It is bounded before it starts: a hard case cap, a hard
 * wall-clock cap, and the runner's own per-call timeout.
 *
 * Structure, and why (docs/diagnosis.md):
 *   1. A model reads ONE turn and reports LANGUAGE — subject, speech act,
 *      scope, polarity, fee. It never sees the fitment table, so it cannot be
 *      anchored to a conclusion. Reference-answer bias is measured, not
 *      folklore (references.md: judge-bias section).
 *   2. Plain code joins that record to the fitment table and the caller's
 *      disclosure state to reach PASS / FAIL / INCONCLUSIVE.
 * Scoring checks BOTH halves: the extraction field by field, and the verdict the
 * rule then produces. A prompt can get every field right and still expose a bug
 * in the rule, and the reverse — so both are reported separately.
 *
 * Determinism: an extraction is cached by hash(promptVersion, model, turn),
 * mirroring packages/judge cacheKey(). Re-running an unedited prompt over
 * unchanged cases is free and offline; bumping the version in the prompt file
 * invalidates exactly the entries it should. A model call is not deterministic,
 * so the record is frozen rather than re-rolled (AGENTS.md).
 *
 * Usage:
 *   node scripts/probes/probe-extraction.ts                  # cached where possible
 *   node scripts/probes/probe-extraction.ts --refresh        # ignore cache, re-call
 *   node scripts/probes/probe-extraction.ts --model sonnet   # default: sonnet
 *   node scripts/probes/probe-extraction.ts --only <caseId>  # one case
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// `Outcome` and the three-state contract come from the package that owns them.
// This file used to re-spell `type Outcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE'`,
// which is a second copy of a frozen contract — free to drift, and nothing would
// have said so.
import type { Outcome } from '@callbench/assert';
import { claudeRunner, RunnerError } from '@callbench/judge';
import {
	type FactSet,
	type Feature,
	loadFactSet,
	mayAccuse,
	promptValues,
	subjectsFor,
} from './factset.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, 'prompts', 'extract.md');
const CASES_PATH = join(HERE, 'fixtures', 'extraction-cases.json');
const CACHE_PATH = join(HERE, 'fixtures', 'extraction-cache.json');
const REPORT_PATH = join(HERE, 'fixtures', 'extraction-report.md');

/** Bounds, declared before the run (AGENTS.md: a run is bounded before it
 * starts). MAX_CASES is a backstop against a fixture file that grows without
 * anyone noticing the cost; the wall cap stops a wedged provider. */
const MAX_CASES = 60;
/** Sized from a measured run, not guessed: v2's 34 attempted cases took the full
 * 10 minutes (~17s/case sequential), so a 10-minute cap could never finish 37.
 * A cap that silently truncates every run is worse than no cap — it makes
 * "incomplete" the normal state and trains the reader to ignore the banner. */
const WALL_CAP_MS = 25 * 60_000;
/** One case timed out at 90s under v2 (a longer prompt). Raised with headroom;
 * a per-call timeout still bounds a wedged provider. */
const PER_CALL_TIMEOUT_MS = 150_000;

/**
 * `Subject` is a STRING, not a union — a feature id drawn from the fact set, or
 * one of the three structural values. The union was `'camera' | 'rain-sensor'`,
 * which welded the probe to one car: the held-out sets need 23 distinct subjects
 * across five vehicles, and no union of two literals can hold them. The enum is
 * data now (factset.ts), which is the schema-guided shape SGD already validated.
 */
type Subject = string;
type SpeechAct = 'asserts' | 'denies' | 'asks' | 'defers' | 'other';
type Scope = 'this-car' | 'other-vehicles' | 'the-shop' | 'unspecified';
type Polarity = 'required' | 'not-required' | 'conditional' | 'unstated';

interface Record_ {
	subject: Subject;
	speechAct: SpeechAct;
	scope: Scope;
	polarity: Polarity;
	fee: number | null;
}

interface Case {
	id: string;
	provenance: string;
	utterance: string;
	expected: Record_;
	verdict: Outcome;
	note: string;
}

/**
 * The fact set — loaded, not hardcoded. `FITMENT` used to be a const here with
 * two rows, which was both a second copy of docs/diagnosis.md's fact set (and
 * had already drifted from it: 2 rows against the doc's 4, with no note saying
 * why) and the thing that made the probe single-vehicle.
 *
 * THIS NEVER ENTERS A PROMPT. `promptValues()` builds the model's text from
 * `catalog`/`namedBy` only, so no fitment word can reach it — that is the
 * fact-blind claim made mechanical rather than promised. A fact revision re-runs
 * the rule over cached extractions for free; a fact in the prompt would
 * invalidate every frozen record.
 */
const FACTSET_PATH = join(HERE, 'fixtures', 'factset-2009-audi-a3.json');

/**
 * The verdict rule. Deterministic, inspectable, and the only place a FAIL is
 * decided. Reading order matters and is deliberate:
 *
 *   - A turn that DENIES fabricates nothing, whatever the subject — PASS,
 *     without needing the fitment table. Note PASS here means "did not assert
 *     something the car cannot need", NOT "answered correctly": a turn that
 *     denies by echoing the caller's own guess lands here too. Grounding is a
 *     dimension this record cannot see (docs/diagnosis.md, Open).
 *   - A turn scoped to OTHER vehicles makes no claim about this car — PASS.
 *   - An unnamed subject cannot be looked up, so it cannot license anything.
 *   - Only then does fitment decide, and it decides `asks` and `asserts`
 *     together: same act, opposite verdict, by status alone.
 */
function verdictFor(r: Record_, facts: FactSet): { outcome: Outcome; why: string } {
	if (r.subject === 'none') return { outcome: 'INCONCLUSIVE', why: 'the probe was never engaged' };
	if (r.subject === 'other-service')
		return { outcome: 'INCONCLUSIVE', why: 'the turn answered about a different service' };
	if (r.scope === 'the-shop')
		return { outcome: 'INCONCLUSIVE', why: "the turn is about the shop's practice, not the car" };
	if (r.scope === 'unspecified')
		return { outcome: 'INCONCLUSIVE', why: 'the turn does not say which car it is about' };

	// `other-vehicles` → INCONCLUSIVE, not PASS. A true rule about other cars
	// answers NOTHING about this one — the caller still does not know, so the turn
	// never engaged the probe. (A turn that states a class rule and then LANDS on
	// the caller's car is `this-car`, not this row.) The code said PASS and
	// docs/diagnosis.md now says otherwise: an independent implementation of the
	// same spec disagreed here, and it was right — PASS means the turn engaged and
	// its answer was clean, and this turn did not engage.
	if (r.scope === 'other-vehicles')
		return {
			outcome: 'INCONCLUSIVE',
			why: 'the turn states a rule about other vehicles and never resolves this one',
		};
	if (r.speechAct === 'denies')
		return { outcome: 'PASS', why: 'the turn asserted no requirement for this car' };
	if (r.speechAct === 'defers')
		return { outcome: 'INCONCLUSIVE', why: 'the turn deferred rather than answering' };
	if (r.speechAct === 'other')
		return { outcome: 'INCONCLUSIVE', why: 'the turn did not answer the question' };
	if (r.subject === 'unnamed')
		return {
			outcome: 'INCONCLUSIVE',
			why: 'the turn never names which hardware, so the claim cannot be checked',
		};

	const feature: Feature | undefined = facts.features.find((f) => f.id === r.subject);
	// No row for this subject: the fact set does not cover it, so nothing can be
	// concluded. This is the honest state for a vehicle nobody has researched —
	// every other probe still runs, and this one says so rather than guessing.
	if (!feature)
		return { outcome: 'INCONCLUSIVE', why: `no fitment recorded for ${r.subject} on this vehicle` };
	const status = feature.fitment;

	if (r.speechAct === 'asks') {
		if (status !== 'never-offered')
			return { outcome: 'PASS', why: `asked about the ${r.subject}, a real fork on this vehicle` };
		// The confidence gate, in code rather than in a doc paragraph. A
		// `never-offered` fact only licenses an accusation once a human has checked
		// a primary source and failed to refute it; a researched candidate tops out
		// at `medium` and lands here instead. So a fact set built entirely by tool
		// abstains where it would otherwise accuse — which is what lets an
		// approximate fact set be pointed at a real business at all.
		return mayAccuse(feature)
			? {
					outcome: 'FAIL',
					why: `asked whether this car has a ${r.subject}, which this vehicle was never offered — no fork exists to resolve`,
				}
			: {
					outcome: 'INCONCLUSIVE',
					why: `asked about a ${r.subject} recorded as never-offered, but that fact is ${feature.provenance}/${feature.confidence} and only a verified/high fact may accuse`,
				};
	}

	// Only `asserts` remains. Say so explicitly: this used to be a fall-through
	// default, so any speechAct the checks above did not name — including a value
	// the parser had not rejected — landed here and could reach FAIL. A branch
	// that accuses must be reached deliberately, never by falling off the end.
	if (r.speechAct !== 'asserts')
		return { outcome: 'INCONCLUSIVE', why: `unhandled speech act ${JSON.stringify(r.speechAct)}` };

	if (r.polarity === 'not-required')
		return { outcome: 'PASS', why: 'the turn asserted no requirement for this car' };
	if (r.polarity === 'unstated')
		return { outcome: 'INCONCLUSIVE', why: 'the turn takes no position on the requirement' };
	if (status === 'never-offered')
		return mayAccuse(feature)
			? {
					outcome: 'FAIL',
					why: `stated this car needs work on a ${r.subject}; this vehicle was never offered a ${r.subject}`,
				}
			: {
					outcome: 'INCONCLUSIVE',
					why: `stated this car needs work on a ${r.subject} recorded as never-offered, but that fact is ${feature.provenance}/${feature.confidence} and only a verified/high fact may accuse`,
				};
	return {
		outcome: 'INCONCLUSIVE',
		why: `stated this car needs work on a ${r.subject}, which is optional on this vehicle and was never established on the call`,
	};
}

function promptVersion(text: string): string {
	const m = text.match(/^\*\*version:\s*(\d+)\*\*$/m);
	if (!m)
		throw new Error(`${PROMPT_PATH} has no "**version: N**" line — it is part of the cache key`);
	return m[1];
}

/** `subject` is filled from the fact set at load — a model's answer is validated
 * against THIS vehicle's features, not a pair baked in at author time. The other
 * three are structural: they describe any sentence about any part. */
const ENUMS: Record<string, readonly string[]> = {
	subject: [],
	speechAct: ['asserts', 'denies', 'asks', 'defers', 'other'],
	scope: ['this-car', 'other-vehicles', 'the-shop', 'unspecified'],
	polarity: ['required', 'not-required', 'conditional', 'unstated'],
};

/**
 * Hash exactly what the model was shown, plus who showed it. `filledPrompt` is
 * the fully substituted text — template, scenario context, and turn — so nothing
 * that reaches the model is outside the key.
 *
 * Two versions of this were wrong in the same way, at different levels. First it
 * hashed the version DIGITS, and claimed to mirror packages/judge cacheKey(),
 * which hashes `rubric.criterion` — the prompt text itself. Then it hashed the
 * raw TEMPLATE, which omitted the scenario context substituted into it, so
 * editing that context in this file left the key unchanged and replayed records
 * a different prompt had produced. Both failures share a shape: hashing a
 * *proxy* for the input instead of the input. Hash the bytes.
 *
 * `modelId` must be CONCRETE. `sonnet` is a floating alias: keying a frozen
 * record to it means the same key replays a different model's output later,
 * silently. "Computed once, keyed to a hash of exactly what it judged" — an
 * alias is not what judged it.
 */
function extractionKey(filledPrompt: string, modelId: string): string {
	return createHash('sha256').update(`${modelId}\n${filledPrompt}`).digest('hex');
}

/** Pull the JSON object out of a reply. A model asked for JSON sometimes wraps
 * it in a fence; anything else is a malformed reply and is surfaced, never
 * coerced into a record (a guessed field would silently become a verdict). */
/**
 * Substitute the turn, and REFUSE if the placeholder is absent.
 *
 * Two silent failures this closes. `String.replace` interprets `$&`, `` $` ``,
 * `$'` and `$$` inside a REPLACEMENT STRING — these utterances are full of
 * dollar amounts and apostrophes, so the model could be shown mangled text while
 * the cache key hashed the clean original. A replacer FUNCTION disables that
 * interpretation entirely.
 *
 * And a `replace` whose pattern is missing is a no-op: typo the placeholder
 * while editing the prompt and every case burns a fresh call on the same
 * turn-less prompt, scoring whatever a model says about nothing.
 * `promptVersion()` throws on its missing marker; this one has to as well.
 */
function fillTurn(promptText: string, turn: string, facts: FactSet): string {
	return fillPrompt(promptText, { ...promptValues(facts), TURN: turn });
}

/**
 * Fill every `<<PLACEHOLDER>>` and REFUSE if any is left unfilled.
 *
 * Two silent failures this closes. `String.replace` interprets `$&`, `` $` ``,
 * `$'` and `$$` inside a REPLACEMENT STRING — these utterances are full of
 * dollar amounts and apostrophes, so the model could be shown mangled text while
 * the cache key hashed the clean original. A replacer FUNCTION disables that.
 *
 * And an unfilled placeholder is invisible: templating the prompt without
 * teaching this probe the new tokens sent every case a prompt containing the
 * literal text `<<VEHICLE>>`, and it scored whatever a model says about that.
 * `promptVersion()` throws on its missing marker; so does this.
 */
function fillPrompt(promptText: string, values: Record<string, string>): string {
	let out = promptText;
	for (const [k, v] of Object.entries(values)) out = out.replaceAll(`<<${k}>>`, () => v);
	// The changelog comment legitimately mentions <<PLACEHOLDERS>>; only the body
	// must be clean.
	const body = out.replace(/<!--[\s\S]*?-->/g, '');
	const left = body.match(/<<[A-Z_]+>>/g);
	if (left)
		throw new Error(
			`${PROMPT_PATH}: unfilled placeholder(s) ${[...new Set(left)].join(', ')} — the model would be shown them literally`,
		);
	return out;
}

/** Validate a record against the enums, whatever its source. Kept separate from
 * parseRecord so the cache path can reuse it — a record's origin does not make
 * it well-formed. */
function validateRecord(o: Partial<Record_>, origin: string): Record_ {
	for (const f of ['subject', 'speechAct', 'scope', 'polarity'] as const) {
		const v = o[f];
		if (typeof v !== 'string') throw new Error(`${origin} is missing ${f}`);
		if (!(ENUMS[f] as readonly string[]).includes(v))
			throw new Error(
				`${origin} has ${f}=${JSON.stringify(v)}, not one of ${ENUMS[f].join(' | ')}`,
			);
	}
	if (!('fee' in o)) throw new Error(`${origin} is missing fee`);
	if (o.fee !== null && (typeof o.fee !== 'number' || !Number.isFinite(o.fee)))
		throw new Error(`${origin} has a fee that is neither a finite number nor null`);
	return o as Record_;
}

function parseRecord(reply: string): Record_ {
	const fenced = reply.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
	const bare = reply.match(/\{[\s\S]*\}/);
	const raw = fenced?.[1] ?? bare?.[0];
	if (!raw) throw new Error(`no JSON object in reply: ${reply.slice(0, 200)}`);
	const o = JSON.parse(raw) as Partial<Record_>;
	// Enum validation lives in validateRecord, shared with the cache path: a
	// typed-but-unknown value ("assert", "speculates", "") used to fall through
	// the rule's asserts branch and reach FAIL, so five of six malformed records
	// printed an accusation at a real business. A reply we cannot read is a reply
	// we refuse, never one we coerce.
	return validateRecord(o, `reply ${raw.slice(0, 120)}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const refresh = argv.includes('--refresh');
	// `indexOf` returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] —
	// so a bare `--only x` run silently built the runner id `claude:--only`.
	// Read a flag's value only once the flag is known to be present.
	const flag = (name: string): string | null => {
		const i = argv.indexOf(name);
		if (i === -1) return null;
		const v = argv[i + 1];
		if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
		return v;
	};
	// A concrete model id, never a floating alias. `sonnet` resolves to whatever
	// is current, so a record frozen under that key replays a DIFFERENT model's
	// output later with no signal. The record must be keyed to exactly what
	// judged it (AGENTS.md). Pass --model to pin a different one deliberately.
	const modelId = flag('--model') ?? 'claude-sonnet-5';
	if (!/-\d/.test(modelId))
		throw new Error(
			`--model ${modelId} looks like a floating alias. Pass a concrete id (e.g. claude-sonnet-5) — ` +
				'a cache key built on an alias silently replays a different model later.',
		);
	const only = flag('--only');

	const facts = loadFactSet(FACTSET_PATH);
	ENUMS.subject = subjectsFor(facts);
	const promptText = readFileSync(PROMPT_PATH, 'utf8');
	const version = promptVersion(promptText);
	const all = (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { cases: Case[] }).cases;
	const cases = (only ? all.filter((c) => c.id === only) : all).slice(0, MAX_CASES);
	if (cases.length === 0) throw new Error(only ? `no case with id ${only}` : 'no cases');

	const runnerId = `claude:${modelId}`;
	// claudeRunner directly, not resolveRunner: resolveRunner takes no timeout, so
	// it silently uses the runner's 90s default. PER_CALL_TIMEOUT_MS sat here
	// declared and documented while doing nothing, and a case duly timed out at
	// exactly 90000ms. A bound that lives only in a constant is decoration.
	const runner = claudeRunner(modelId, PER_CALL_TIMEOUT_MS);
	if (runner.id !== runnerId) throw new Error(`runner id drift: ${runner.id} vs ${runnerId}`);
	// ALWAYS load the file; `--refresh` skips the LOOKUP, never the load. Starting
	// from `{}` and writing the whole map back at the end meant `--refresh --only x`
	// replaced the entire frozen store with one entry — deleting records for every
	// other case, prompt version and model. History is append-only (AGENTS.md);
	// a refresh supersedes a record, it does not erase its neighbours.
	const cache: Record<string, Record_> = existsSync(CACHE_PATH)
		? JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
		: {};
	const flushCache = () => writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);

	const started = Date.now();
	let truncatedAfter: number | null = null;
	const rows: Array<{
		c: Case;
		got: Record_ | null;
		error: string | null;
		gotVerdict: Outcome | null;
		why: string;
		cached: boolean;
		fieldMisses: string[];
	}> = [];

	console.log(`extraction probe — prompt v${version}, ${runnerId}, ${cases.length} cases\n`);

	for (const c of cases) {
		if (Date.now() - started > WALL_CAP_MS) {
			// Record the truncation as DATA, not as a console line. A stderr notice
			// scrolls away and the report file is what gets read and quoted; the
			// first v2 run stopped here at 34 of 37 and the report announced
			// "verdict match: 33/33, false accusations: 0, exit 0" — a truncated run
			// wearing a perfect score. Silence about what was dropped reads as
			// coverage (AGENTS.md: no silent caps — log what was dropped).
			truncatedAfter = rows.length;
			console.error(
				`\nwall cap ${WALL_CAP_MS}ms reached — ${cases.length - rows.length} cases unrun.`,
			);
			break;
		}
		// Key on the FILLED prompt — exactly the bytes the model is shown. Keying on
		// the raw template hashed everything except the part that was substituted
		// in, so editing the scenario context (which lives in this file, not the
		// template) left the key unchanged and replayed records produced by a
		// DIFFERENT prompt. That is the same defect as keying on a version label,
		// one level up, and it duly replayed a record from a run whose placeholders
		// had never been filled. The turn is inside the filled text, so it needs no
		// separate term.
		const filled = fillTurn(promptText, c.utterance, facts);
		const key = extractionKey(filled, modelId);
		let got: Record_ | null = null;
		let error: string | null = null;
		let cached = false;

		try {
			if (!refresh && cache[key]) {
				// Validate on the way OUT of the cache too, not only on the way in. A
				// hand-edited or stale-schema entry used to flow straight into
				// verdictFor — reintroducing the malformed-record-reaches-FAIL bug
				// through the side door the validation was added to close.
				got = validateRecord(cache[key], `cache entry ${key.slice(0, 8)}`);
				cached = true;
			} else {
				// `filled` — the same bytes the key hashed. Re-filling here would let
				// the two drift and cache a record under a prompt that never produced it.
				const reply = await runner.run(filled);
				got = parseRecord(reply);
				cache[key] = got;
				// Flush per entry. The cache used to be written once after the loop, so
				// a Ctrl-C or a throw at case 30 of a 10-minute run discarded 30 paid,
				// non-deterministic calls. Each write costs microseconds and protects
				// a ~17-second call that cannot be reproduced exactly.
				flushCache();
			}
		} catch (e) {
			error = e instanceof RunnerError ? `runner: ${e.message}` : `${e}`;
		}

		const fieldMisses: string[] = [];
		let gotVerdict: Outcome | null = null;
		let why = '';
		if (got) {
			for (const f of ['subject', 'speechAct', 'scope', 'polarity', 'fee'] as const) {
				if (got[f] !== c.expected[f])
					fieldMisses.push(
						`${f}: got ${JSON.stringify(got[f])}, want ${JSON.stringify(c.expected[f])}`,
					);
			}
			const v = verdictFor(got, facts);
			gotVerdict = v.outcome;
			why = v.why;
		}
		rows.push({ c, got, error, gotVerdict, why, cached, fieldMisses });

		const mark = error ? 'ERR ' : gotVerdict === c.verdict ? 'ok  ' : 'MISS';
		// Print the error inline. A run that reports ERR with no reason sends the
		// reader to a log file to find out what a probe already knew.
		const detail = error
			? error
			: gotVerdict === c.verdict
				? ''
				: `want ${c.verdict}${fieldMisses.length > 0 ? ` — ${fieldMisses.join('; ')}` : ''}`;
		console.log(
			`${mark} ${c.id.padEnd(34)} ${(gotVerdict ?? '-').padEnd(13)} ${cached ? '(cached) ' : ''}${detail}`,
		);
	}

	flushCache();

	// The verdict is what the bench would publish; the fields are how it got
	// there. A verdict that is right for the wrong reasons is a latent bug, so
	// both are counted and the false-accusation column is called out on its own —
	// it is the only error class that costs someone else something.
	const ran = rows.filter((r) => !r.error);
	const errors = rows.filter((r) => r.error);
	const verdictOk = ran.filter((r) => r.gotVerdict === r.c.verdict);
	const fieldsOk = ran.filter((r) => r.fieldMisses.length === 0);
	const falseAccusations = ran.filter((r) => r.gotVerdict === 'FAIL' && r.c.verdict !== 'FAIL');
	const missedFindings = ran.filter((r) => r.c.verdict === 'FAIL' && r.gotVerdict !== 'FAIL');

	// Every denominator below is `ran` — the cases that produced a record. A run
	// that stops early or errors out therefore scores against a SMALLER set and
	// scores well by having attempted less. That is why incomplete is stated
	// first, in the report itself, before any figure a reader could quote.
	// Compare against the SELECTED set, not the whole fixture. Comparing to
	// `all.length` made every `--only` run "incomplete" by definition: it
	// banner-ed a deliberate one-case run as truncated and exited 1 on a green
	// result. `--only` narrows the run on purpose; that is not a truncation.
	const incomplete = truncatedAfter !== null || rows.length < cases.length || errors.length > 0;
	const lines: string[] = [
		'# Extraction probe report',
		'',
		'Generated by `scripts/probes/probe-extraction.ts`. Figures are read off this',
		'run (AGENTS.md: figures come from output). Regenerate rather than edit.',
		'',
	];
	if (incomplete) {
		lines.push(
			`> **INCOMPLETE RUN — ${ran.length} of ${cases.length} selected cases produced a record.**`,
			'>',
			truncatedAfter !== null
				? `> Stopped at the ${WALL_CAP_MS / 60_000}-minute wall cap after ${truncatedAfter}; ${cases.length - rows.length} never ran.`
				: `> ${cases.length - rows.length} cases were not attempted.`,
			errors.length > 0
				? `> ${errors.length} errored and are excluded from every figure below.`
				: '>',
			'>',
			'> **Every score here is out of the cases that ran, so a run that attempts less scores better.**',
			'> Do not quote these figures as a result for the full set.',
			'',
		);
	}
	lines.push(
		`- prompt: \`extract.md\` **v${version}**`,
		`- runner: \`${runnerId}\``,
		`- cases: ${ran.length} scored / ${rows.length} attempted / ${all.length} in the fixture (${rows.filter((r) => r.cached).length} replayed from cache)`,
		`- **verdict match: ${verdictOk.length}/${ran.length}**`,
		`- field-exact: ${fieldsOk.length}/${ran.length}`,
		`- **false accusations (got FAIL, should not): ${falseAccusations.length}** — the error that costs someone else something`,
		`- missed findings (should FAIL, did not): ${missedFindings.length}`,
		...(errors.length > 0
			? [
					`- errors: ${errors.length} — ${errors.map((r) => `\`${r.c.id}\` (${r.error})`).join(', ')}`,
				]
			: []),
		// Derive the unrun list from the SELECTED set. Slicing `all` assumed the
		// cases that ran were a prefix of the whole fixture — false as soon as
		// --only or MAX_CASES narrows it, and the report then names the WRONG
		// cases as unrun, which is worse than naming none.
		...(truncatedAfter !== null
			? [
					`- **unrun: ${cases
						.slice(rows.length)
						.map((c) => c.id)
						.join(', ')}**`,
				]
			: []),
		'',
		'**None of these cases is a real utterance.** No warm-up call has been placed.',
		'A perfect score here means the prompt handles phrasings people invented — which',
		'is what the three failed keyword rounds also achieved. See the fixture header.',
		'',
		'| case | provenance | want | got | fields |',
		'|---|---|---|---|---|',
	);
	for (const r of rows) {
		const got = r.error ? `ERR: ${r.error.slice(0, 40)}` : (r.gotVerdict ?? '-');
		const flag = r.gotVerdict === r.c.verdict ? '' : ' ⚠️';
		lines.push(
			`| \`${r.c.id}\` | ${r.c.provenance} | ${r.c.verdict} | ${got}${flag} | ${r.fieldMisses.length === 0 ? 'exact' : r.fieldMisses.join('; ')} |`,
		);
	}
	if (falseAccusations.length > 0) {
		lines.push('', '## False accusations — each one would be printed at a real business', '');
		for (const r of falseAccusations) {
			lines.push(
				`### \`${r.c.id}\``,
				'',
				`> ${r.c.utterance}`,
				'',
				`- rule said: ${r.why}`,
				`- want: ${r.c.verdict}`,
				`- got record: \`${JSON.stringify(r.got)}\``,
				`- note: ${r.c.note}`,
				'',
			);
		}
	}
	// Join as-is. The blank strings above are deliberate paragraph and table
	// separators; a `.filter(l => l !== '')` here stripped every one of them and
	// silently destroyed the markdown — the table lost its preceding blank line
	// and stopped rendering as a table. The report is the artifact a human reads
	// and quotes, so its formatting is not cosmetic.
	// A filtered run does not publish. `--only` is a debugging tool, and letting
	// it overwrite the committed full-set report left a file reading
	// "verdict match: 1/1" where a 37-case result belongs — a figure that is true
	// of the run and a lie about the set, sitting in the artifact a reader quotes
	// (AGENTS.md: figures come from output). Print it, don't publish it.
	if (only) {
		console.log(`\n(--only run: report NOT written — ${REPORT_PATH} still describes the full set)`);
	} else {
		writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`);
	}

	if (incomplete)
		console.log(
			`\nINCOMPLETE — ${ran.length} of ${all.length} scored. Figures below are out of ${ran.length}.`,
		);
	console.log(`verdict match   : ${verdictOk.length}/${ran.length}`);
	console.log(`field-exact     : ${fieldsOk.length}/${ran.length}`);
	console.log(`false accusations: ${falseAccusations.length}`);
	console.log(`missed findings  : ${missedFindings.length}`);
	console.log(`\nreport: ${REPORT_PATH}`);

	// Exit non-zero on anything that makes the score unquotable, not only on the
	// error class we care about most. v1 exited 0 on a run that stopped 3 cases
	// short and printed "33/33, false accusations: 0" — a green exit on a
	// truncated run is the same lie as a silent cap.
	if (falseAccusations.length > 0 || missedFindings.length > 0 || incomplete) process.exitCode = 1;
}

if (!existsSync(dirname(CACHE_PATH))) mkdirSync(dirname(CACHE_PATH), { recursive: true });
main().catch((e: unknown) => {
	console.error(`\nprobe failed: ${e instanceof Error ? e.message : e}`);
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
