/**
 * Fact sets — a vehicle's features, what its trade words can mean, and which of
 * those the vehicle was actually offered with.
 *
 * This is the "subject enum is DATA, not a type" refactor. The probe used to
 * carry `type Subject = 'camera' | 'rain-sensor' | ...` and a hardcoded FITMENT
 * const, which welded the whole bench to one car: the held-out sets need 23
 * distinct subjects across five vehicles, and a union of two string literals
 * cannot hold them. Passing the schema in rather than baking it in is the
 * schema-guided paradigm (SGD — docs/references.md, DST section); we converged
 * on it by accident and are now adopting it on purpose.
 *
 * THE SPLIT THAT MAKES AN APPROXIMATE FACT SET SAFE:
 *   - `catalog` and `namedBy` are SHOWN to the model. They say what the WORDS
 *     can refer to. Listing a feature is not disclosing that it is fitted.
 *   - `fitment`, `confidence` and `provenance` are NEVER shown. They say what
 *     the CAR has, and they are read only by the verdict rule.
 *
 * So a `declared` (invented for test) or `researched` (found by a tool) fact set
 * gives full coverage of every verdict that costs nobody anything, while a FAIL
 * — the one that accuses a real business in writing — waits on a `verified`
 * fact. Coverage scales; accusation does not. That is what lets a demo run on
 * approximate data without the approximation ever reaching a stranger.
 */

import { readFileSync } from 'node:fs';

export type Fitment = 'never-offered' | 'optional' | 'standard';
export type Confidence = 'low' | 'medium' | 'high';
/** How the fact was come by. `declared` — invented for a test, certain because
 * we decided it. `researched` — a tool's candidate, never better than `medium`.
 * `verified` — a human checked a primary source and failed to refute it. */
export type Provenance = 'declared' | 'researched' | 'verified';

/** The structural subjects. They belong to the schema, not to any vehicle, so
 * they are the only subject values that are not feature ids. */
export const STRUCTURAL_SUBJECTS = ['unnamed', 'other-service', 'none'] as const;

export interface Feature {
	id: string;
	label: string;
	/** Shown to the model: what this hardware IS. Never says whether it is fitted. */
	catalog: string;
	/** Shown to the model: the words that name it. */
	namedBy: string;
	/** NOT shown to the model. */
	fitment: Fitment;
	confidence: Confidence;
	provenance: Provenance;
	source: string;
	limits?: string;
}

export interface FactSet {
	vehicle: { id: string; display: string; short: string; generation?: string; market?: string };
	service: string;
	callerQuestion: string;
	overloadedTerms: string;
	features: Feature[];
}

/**
 * May this fact license a FAIL — the only verdict that accuses anyone?
 *
 * Two conditions, both required, and neither is a formality:
 *   - `never-offered`. `optional` means the agent genuinely cannot know, so
 *     asserting it is a guess and the disambiguation assertion carries it.
 *   - `high` confidence AND `verified` provenance. A researched fact tops out at
 *     `medium` by construction (scripts/find-fact.ts), so a tool's output can
 *     never accuse. A `declared` fact is certain — but it is certain about an
 *     invented car, so it cannot accuse a real one either; it simply never meets
 *     a real business.
 *
 * `declared` is deliberately allowed to FAIL: a fictional vehicle's fact set is
 * true by construction, and the held-out sets need FAIL to be reachable or they
 * test nothing. The safety is that a fictional car has no shop to accuse.
 */
export function mayAccuse(f: Feature): boolean {
	if (f.fitment !== 'never-offered') return false;
	if (f.provenance === 'declared') return true;
	return f.provenance === 'verified' && f.confidence === 'high';
}

export function loadFactSet(path: string): FactSet {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FactSet> & Record<string, unknown>;
	for (const k of ['vehicle', 'service', 'callerQuestion', 'overloadedTerms', 'features'] as const)
		if (raw[k] === undefined) throw new Error(`${path}: missing ${k}`);
	const fs_ = raw as FactSet;
	if (!Array.isArray(fs_.features) || fs_.features.length === 0)
		throw new Error(`${path}: features must be a non-empty array`);

	const seen = new Set<string>();
	for (const f of fs_.features) {
		for (const k of [
			'id',
			'label',
			'catalog',
			'namedBy',
			'fitment',
			'confidence',
			'provenance',
			'source',
		] as const)
			if (typeof f[k] !== 'string' || f[k] === '')
				throw new Error(`${path}: feature ${f.id ?? '?'} missing ${k}`);
		// A feature id may never collide with a structural subject: `unnamed` means
		// "the turn named no hardware", and a feature actually called `unnamed`
		// would make that indistinguishable from an answer.
		if ((STRUCTURAL_SUBJECTS as readonly string[]).includes(f.id))
			throw new Error(`${path}: feature id "${f.id}" collides with a structural subject`);
		if (seen.has(f.id)) throw new Error(`${path}: duplicate feature id "${f.id}"`);
		seen.add(f.id);
		if (!['never-offered', 'optional', 'standard'].includes(f.fitment))
			throw new Error(`${path}: feature ${f.id} has fitment "${f.fitment}"`);
		if (!['low', 'medium', 'high'].includes(f.confidence))
			throw new Error(`${path}: feature ${f.id} has confidence "${f.confidence}"`);
		if (!['declared', 'researched', 'verified'].includes(f.provenance))
			throw new Error(`${path}: feature ${f.id} has provenance "${f.provenance}"`);
		// A researched fact claiming to be verified-grade is the one lie that would
		// let a tool's guess accuse a business. Refuse it rather than downgrade it:
		// a silent downgrade hides that someone wrote it down wrong.
		if (f.provenance === 'researched' && f.confidence === 'high')
			throw new Error(
				`${path}: feature ${f.id} is researched at high confidence. A tool's candidate tops out at ` +
					'medium; high requires a human who checked a primary source and tried to refute it.',
			);
	}
	return fs_;
}

/** The subject values a model may return for this vehicle: its feature ids plus
 * the structural ones. This is the enum, derived — never a type. */
export function subjectsFor(fs_: FactSet): string[] {
	return [...fs_.features.map((f) => f.id), ...STRUCTURAL_SUBJECTS];
}

/** The prompt fragments. Both are built ONLY from `catalog` / `namedBy` — the
 * fields that describe the hardware. `fitment` never reaches this function's
 * output, which is the mechanical guarantee behind the fact-blind claim. */
export function promptValues(fs_: FactSet): Record<string, string> {
	return {
		SERVICE: fs_.service,
		VEHICLE: fs_.vehicle.display,
		VEHICLE_SHORT: fs_.vehicle.short,
		CALLER_QUESTION: fs_.callerQuestion,
		OVERLOADED_TERMS: fs_.overloadedTerms,
		SUBJECT_CATALOG: fs_.features.map((f) => `- **${f.label}.** ${f.catalog}`).join('\n'),
		SUBJECT_ENUM: fs_.features
			.map((f) => `- \`"${f.id}"\` — **only if the turn names it**: ${f.namedBy}.`)
			.join('\n'),
	};
}
