/**
 * The spec derivation is the seam that keeps vehicle knowledge in data: a
 * fact-set feature in, an assertion spec out, no hand-typed vocabulary in
 * between. These pin the derivation's load-bearing properties — terms come
 * from `namedBy`, the accusation gate rides along, and a scenario naming a
 * feature the fact set lacks is refused loudly.
 */

import { describe, expect, it } from 'vitest';
import type { FactSet, Feature } from '../factset.ts';
import { requirementSpecFor, subjectTermsFor } from '../spec.ts';

const feature = (over: Partial<Feature>): Feature => ({
	id: 'fwd-camera',
	label: 'Forward-facing camera',
	catalog: 'A windshield-mounted camera used by driver-assistance systems.',
	namedBy: 'camera, forward camera, ADAS, lane assist, or an equivalent',
	fitment: 'never-offered',
	confidence: 'high',
	provenance: 'verified',
	source: 'test',
	...over,
});

const factset = (features: Feature[]): FactSet => ({
	vehicle: { id: 'test-vehicle', display: '2009 Test Vehicle', short: 'the Test' },
	service: 'windshield replacement',
	callerQuestion: 'Does it need a camera recalibration?',
	overloadedTerms: 'recalibration',
	features,
});

describe('subjectTermsFor', () => {
	it('splits namedBy prose into lowercase noun phrases, longest first', () => {
		const terms = subjectTermsFor(feature({}));
		expect(terms).toContain('camera');
		expect(terms).toContain('forward camera');
		expect(terms).toContain('adas');
		expect(terms).toContain('lane assist');
		// Longest first: a specific phrase must win before its generic substring.
		expect(terms.indexOf('forward camera')).toBeLessThan(terms.indexOf('camera'));
	});

	it('strips connective lead-ins so "sometimes called the eyelash" derives "eyelash"', () => {
		const terms = subjectTermsFor(
			feature({ namedBy: 'rain sensor, sometimes called the eyelash' }),
		);
		expect(terms).toContain('rain sensor');
		expect(terms).toContain('eyelash');
	});
});

describe('requirementSpecFor', () => {
	it('derives the spec from the feature: terms, fitment, and the accusation gate', () => {
		const spec = requirementSpecFor(factset([feature({})]), 'fwd-camera');
		expect(spec.name).toBe('requirement-fwd-camera');
		expect(spec.fitment).toBe('never-offered');
		expect(spec.mayAccuse).toBe(true); // verified + high + never-offered
		expect(spec.subjectTerms).toContain('forward camera');
	});

	it('a weak fact keeps its probe but loses its accusation license', () => {
		const spec = requirementSpecFor(
			factset([feature({ provenance: 'researched', confidence: 'medium' })]),
			'fwd-camera',
		);
		expect(spec.mayAccuse).toBe(false);
	});

	it('folds in scenario-supplied extra terms, deduplicated and lowercased', () => {
		const spec = requirementSpecFor(factset([feature({})]), 'fwd-camera', [
			'Recalibration',
			'recalibrat',
			'camera',
		]);
		expect(spec.subjectTerms).toContain('recalibration');
		expect(spec.subjectTerms).toContain('recalibrat');
		expect(spec.subjectTerms.filter((t) => t === 'camera')).toHaveLength(1);
	});

	it('refuses a feature id the fact set lacks — grading against nothing is authored wrong', () => {
		expect(() => requirementSpecFor(factset([feature({})]), 'heated-windshield')).toThrow(
			/no feature "heated-windshield"/,
		);
	});
});
