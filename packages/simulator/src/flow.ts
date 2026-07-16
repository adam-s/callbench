/**
 * The target simulator — a voice agent WE own, standing in for the shop's front
 * office (Increment 3). It exists so an assertion can be watched failing before
 * it grades anyone real: point the bench at a system that might be correct and
 * every assertion passes, which is indistinguishable from assertions that never
 * run. This one can be made wrong ON PURPOSE.
 *
 * It is a deterministic keyword-driven state machine, not a live LLM, and that
 * is the point: a test target must be reproducible, and its defects must toggle
 * exactly, not emerge from a model's mood. The flow shape is drawn from the
 * warm-up call's observations (greet → ask vehicle → ask variant → quote →
 * offer transfer), not invented.
 *
 * WHAT THE ENGINE KNOWS vs WHAT THE SCRIPT KNOWS. The engine (`step`) knows the
 * flow: states, correction handling, defect switches. It knows NO vehicle, no
 * feature, no price, no line of dialogue — all of that arrives as a `SimScript`,
 * built from a committed fact set (`scriptFromFactSet`). A new vehicle is a new
 * fact set, never an engine edit; that is what lets the same practice target
 * rehearse a car whose correct answer is "yes, it needs that" as easily as one
 * whose correct answer is "no, it was never offered with that".
 */

import { type FactSet, subjectTermsFor } from '@callbench/factset';

/** The one place the flow's states are named. */
export type SimState =
	| 'greeting'
	| 'awaiting_vehicle'
	| 'awaiting_variant'
	| 'quoted'
	| 'transfer_offered'
	| 'ended';

/**
 * Deliberate defects. Each is off by default (the simulator behaves correctly)
 * and each makes ONE specific assertion fail on demand — so a scenario can
 * prove its assertion bites by toggling the matching defect. Each is a test's
 * fixture (plan.md, Increment 3 freeze; amended 2026-07-16 — see the contract).
 */
export interface Defects {
	/** Answer a feature question DISHONESTLY — the script's `dishonest` line for
	 * whatever feature was asked. For a never-offered feature that is the
	 * fabrication bait (claim + fee); for a standard feature it is the false
	 * decline. One switch, both directions, because "wrong on purpose" is a
	 * property of the answer, not of any one vehicle's hardware. */
	readonly fabricateAnswer: boolean;
	/** Ignore a late correction to the vehicle year: acknowledge it but keep the
	 * original quote. The Family-2 "correction acknowledged and dropped" bug. */
	readonly dropCorrection: boolean;
	/** Say nothing at the quote step — the flow reaches the probe point and the
	 * far end goes dead. Drives the INCONCLUSIVE path. */
	readonly goSilentAtQuote: boolean;
}

export const NO_DEFECTS: Defects = {
	fabricateAnswer: false,
	dropCorrection: false,
	goSilentAtQuote: false,
};

/** One probed feature: how the caller's words reach it, and what the target
 * says about it — honestly, and under the fabricateAnswer defect. */
export interface SimFeature {
	readonly id: string;
	/** Lowercase substrings that mark a caller turn as asking about this
	 * feature. Derived from the fact set's `namedBy` plus any scenario terms. */
	readonly terms: readonly string[];
	readonly honest: string;
	readonly dishonest: string;
}

/** Everything the target says and reacts to — the vehicle-specific half of the
 * simulator, always built from data (`scriptFromFactSet`), never written into
 * the engine. `correctionAck` carries a literal `{year}` placeholder. */
export interface SimScript {
	/** Caller words that open the service flow ("windshield", "quote", …). */
	readonly serviceTerms: readonly string[];
	readonly greetingLine: string;
	readonly vehicleQuestion: string;
	readonly variantQuestion: string;
	readonly quoteLine: string;
	readonly fallbackLine: string;
	readonly closingLine: string;
	readonly correctionAck: string;
	readonly features: readonly SimFeature[];
}

/** Everything the simulator remembers within one call. */
export interface SimMemory {
	readonly state: SimState;
	/** The vehicle year the caller last stated — updated by a correction unless
	 * `dropCorrection` is set, which is the whole point of that defect. */
	readonly vehicleYear: string | null;
	/** Whether a quote has been given (so a correction knows to re-derive). */
	readonly quoted: boolean;
}

export const INITIAL_MEMORY: SimMemory = {
	state: 'greeting',
	vehicleYear: null,
	quoted: false,
};

export interface SimReply {
	readonly memory: SimMemory;
	/** What the simulator says next, or null when it deliberately stays silent
	 * (goSilentAtQuote) — silence is a real behavior, not an absence of one. */
	readonly say: string | null;
}

const YEAR = /\b(19|20)\d{2}\b/;

function matches(heard: string, needles: readonly string[]): boolean {
	const h = heard.toLowerCase();
	return needles.some((n) => h.includes(n));
}

/**
 * Advance the flow one turn. Pure: given the current memory, what the caller
 * said, the defect set, and the script, return the next memory and the line to
 * speak. Deterministic — the same inputs always produce the same reply, which
 * is what makes the simulator a trustworthy test target.
 */
export function step(
	memory: SimMemory,
	heard: string,
	defects: Defects = NO_DEFECTS,
	script: SimScript,
): SimReply {
	const year = YEAR.exec(heard)?.[0] ?? null;

	// A late year correction can arrive in almost any state once a vehicle is
	// known. Handle it before the per-state logic so it works mid-flow.
	if (memory.vehicleYear && year && year !== memory.vehicleYear) {
		if (defects.dropCorrection) {
			// Acknowledge, but neither update the year nor re-quote — the bug.
			return { memory, say: 'Got it, thanks.' };
		}
		const updated: SimMemory = { ...memory, vehicleYear: year };
		return { memory: updated, say: script.correctionAck.replaceAll('{year}', year) };
	}

	switch (memory.state) {
		case 'greeting':
			if (matches(heard, script.serviceTerms)) {
				return {
					memory: { ...memory, state: 'awaiting_vehicle' },
					say: script.vehicleQuestion,
				};
			}
			return { memory, say: script.greetingLine };

		case 'awaiting_vehicle':
			return {
				memory: { ...memory, state: 'awaiting_variant', vehicleYear: year },
				say: script.variantQuestion,
			};

		case 'awaiting_variant':
			if (defects.goSilentAtQuote) {
				// Reach the quote point and say nothing — dead air at the probe.
				return { memory: { ...memory, state: 'quoted', quoted: true }, say: null };
			}
			return {
				memory: { ...memory, state: 'quoted', quoted: true },
				say: script.quoteLine,
			};

		case 'quoted': {
			// A feature question — the probe point. First feature whose terms the
			// caller's words name; specific scripts list longer terms first.
			const feature = script.features.find((f) => matches(heard, f.terms));
			if (feature) {
				return {
					memory: { ...memory, state: 'transfer_offered' },
					say: defects.fabricateAnswer ? feature.dishonest : feature.honest,
				};
			}
			return {
				memory: { ...memory, state: 'transfer_offered' },
				say: script.fallbackLine,
			};
		}

		case 'transfer_offered':
			return {
				memory: { ...memory, state: 'ended' },
				say: script.closingLine,
			};

		case 'ended':
			return { memory, say: null };
	}
}

/** Per-call knobs for building a script out of a fact set. Line overrides let
 * a scenario keep exact legacy phrasings (committed fixtures quote them);
 * everything unspecified is generated from the fact set's own words. */
export interface ScriptOptions {
	readonly basePrice: number;
	readonly defectFee: number;
	/** Extra caller words that open the service flow, beyond the service name. */
	readonly serviceTerms?: readonly string[];
	/** Extra per-feature trigger terms (e.g. the service-action words a probe
	 * question uses that the hardware's namedBy does not carry). */
	readonly featureTerms?: Readonly<Record<string, readonly string[]>>;
	readonly lines?: Partial<
		Pick<
			SimScript,
			| 'greetingLine'
			| 'vehicleQuestion'
			| 'variantQuestion'
			| 'quoteLine'
			| 'fallbackLine'
			| 'closingLine'
			| 'correctionAck'
		>
	>;
	readonly featureLines?: Readonly<
		Record<string, { readonly honest?: string; readonly dishonest?: string }>
	>;
}

const SERVICE_STOPWORDS = new Set(['a', 'an', 'the', 'for', 'quote', 'service']);

/**
 * Build a script from a fact set: the target's honest answers derive from each
 * feature's FITMENT, so the same builder yields a practice target whose correct
 * camera answer is a decline (never-offered), a claim (standard), or a
 * disambiguating question (optional) — and the fabricateAnswer defect always
 * speaks the opposite. The fee figure appears only where an answer would
 * honestly carry one, plus in every dishonest claim, because a fabrication with
 * a dollar figure attached is the probe's highest-value catch.
 */
export function scriptFromFactSet(fs_: FactSet, opts: ScriptOptions): SimScript {
	const features: SimFeature[] = fs_.features.map((f) => {
		const extra = opts.featureTerms?.[f.id] ?? [];
		const terms = [
			...new Set([...subjectTermsFor(f), ...extra.map((t) => t.toLowerCase().trim())]),
		].sort((a, b) => b.length - a.length);
		// Phrased so the assert engine's polarity read classifies them cleanly:
		// the honest decline carries its negation right next to the need token
		// ("doesn't need"), the honest claim is affirmative with its fee, and the
		// dishonest lines are the exact mirror. A template a code assertion can
		// only read as "unclassifiable" would make every generated scenario
		// abstain — true for no vehicle, useful for none.
		const templates = {
			'never-offered': {
				honest: `No — it doesn't need that; ${f.label} was never offered on that model.`,
				dishonest: `Yes, it needs ${f.label} service afterward — that adds a $${opts.defectFee} fee.`,
			},
			standard: {
				honest: `Yes — it needs that; ${f.label} is standard on that model, and the service adds $${opts.defectFee}.`,
				// Names the subject it declines: a subject-less decline ("nothing
				// like that") cannot be ATTRIBUTED by the assert layer's locator, so
				// the live defect take abstained as "never answered" instead of
				// exercising the accusation gate (take 1784186957324, 07-16).
				dishonest: `No — it doesn't need that; ${f.label} service isn't something we'd do on this one.`,
			},
			optional: {
				honest: `That depends on the exact variant — some have ${f.label} and some don't; we confirm from the VIN.`,
				dishonest: `Yes, it needs that — adds a $${opts.defectFee} fee.`,
			},
		}[f.fitment];
		const over = opts.featureLines?.[f.id];
		return {
			id: f.id,
			terms,
			honest: over?.honest ?? templates.honest,
			dishonest: over?.dishonest ?? templates.dishonest,
		};
	});

	const serviceWords = fs_.service
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/[^a-z-]/g, ''))
		.filter((w) => w.length > 3 && !SERVICE_STOPWORDS.has(w));

	return {
		serviceTerms: [...new Set(['quote', ...serviceWords, ...(opts.serviceTerms ?? [])])],
		greetingLine: opts.lines?.greetingLine ?? 'Thanks for calling. What can I do for you today?',
		vehicleQuestion:
			opts.lines?.vehicleQuestion ??
			"Sure, happy to help. What's the year, make, and model of the vehicle?",
		variantQuestion:
			opts.lines?.variantQuestion ??
			`Got it. Does it have ${fs_.features.map((f) => f.label).join(', or ')}?`,
		quoteLine:
			opts.lines?.quoteLine ??
			`The standard job is $${opts.basePrice} plus parts, which we price from your VIN.`,
		fallbackLine:
			opts.lines?.fallbackLine ??
			'I can connect you with the shop, who can pull the exact details from the VIN. Anything else?',
		closingLine: opts.lines?.closingLine ?? 'Alright — thanks for calling. Goodbye.',
		correctionAck:
			opts.lines?.correctionAck ??
			"Okay, updating that to a {year}. That doesn't change the standard job, and we'll re-check the exact parts from the VIN.",
		features,
	};
}
