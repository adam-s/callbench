/**
 * Derive an assertion spec from a fact-set feature — the bridge that keeps
 * vehicle knowledge in DATA. The assert package's requirement engine
 * (@callbench/assert `requirementAnswer`) takes a spec of this shape; nothing
 * there knows any vehicle. This function is the one place the mapping from
 * "what the fact set records" to "what the assertion needs" is written down,
 * so a new vehicle is a new fact-set file, never a new spec by hand.
 */

import { type FactSet, type Feature, mayAccuse } from './factset.ts';

/** Structurally identical to @callbench/assert's RequirementProbeSpec — kept
 * as its own declaration so factset does not depend on assert (the dependency
 * points the other way at the scenario layer, which imports both). */
export interface DerivedRequirementSpec {
	readonly name: string;
	readonly subjectTerms: readonly string[];
	readonly fitment: Feature['fitment'];
	readonly mayAccuse: boolean;
}

/**
 * Subject terms come from the feature's `namedBy` — the same field the
 * extraction prompt shows the model, so the code seam and the model seam
 * recognize the same vocabulary. `namedBy` is prose ("rain/light sensor
 * behind the mirror, sometimes called the eyelash"); the terms are its
 * comma/slash/or-separated phrases, lowercased, longest first so a specific
 * phrase wins before a generic word.
 */
export function subjectTermsFor(feature: Feature): string[] {
	const terms = feature.namedBy
		.toLowerCase()
		.split(/[,;/]|\bor\b/)
		.map((t) => t.replace(/[."']/g, '').replace(/\s+/g, ' ').trim())
		// Drop connective scraps ("sometimes called the", "a") that splitting
		// leaves behind: a term must carry a noun, and shorter than four
		// characters is a determiner or a scrap, not hardware.
		.map((t) => t.replace(/^(?:sometimes called|also called|known as|called)\s+/, ''))
		.map((t) => t.replace(/^(?:the|a|an)\s+/, ''))
		.filter((t) => t.length >= 4);
	return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

/** Build the requirement-probe spec for one feature of one vehicle. Throws if
 * the feature id is absent — a scenario naming a feature its fact set lacks is
 * authored wrong, and silence here would grade against nothing.
 *
 * `extraTerms` lets the SCENARIO add service-action vocabulary the hardware's
 * `namedBy` does not carry (the A3 probe asks about "recalibration"; namedBy
 * names the camera). That is scenario data naming scenario specifics — the
 * correct home — not vocabulary re-entering engine code. */
export function requirementSpecFor(
	fs_: FactSet,
	featureId: string,
	extraTerms: readonly string[] = [],
): DerivedRequirementSpec {
	const feature = fs_.features.find((f) => f.id === featureId);
	if (!feature) {
		const known = fs_.features.map((f) => f.id).join(', ');
		throw new Error(`fact set ${fs_.vehicle.id} has no feature "${featureId}" (known: ${known})`);
	}
	const derived = subjectTermsFor(feature);
	const subjectTerms = [
		...new Set([...derived, ...extraTerms.map((t) => t.toLowerCase().trim())]),
	].sort((a, b) => b.length - a.length);
	if (subjectTerms.length === 0) {
		throw new Error(
			`feature "${featureId}" of ${fs_.vehicle.id} derives no subject terms from namedBy: "${feature.namedBy}"`,
		);
	}
	return {
		name: `requirement-${featureId}`,
		subjectTerms,
		fitment: feature.fitment,
		mayAccuse: mayAccuse(feature),
	};
}
