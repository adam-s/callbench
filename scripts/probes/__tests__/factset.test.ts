/**
 * The fact set's three safety properties, which had NO tests at all until a
 * mutation run showed every one of them could be deleted in silence:
 *
 *   - `mayAccuse` could return true unconditionally — a tool's guess accusing a
 *     real business in writing, and 211 tests stayed green.
 *   - the researched+high refusal, described at its own code site as "the one lie
 *     that would let a tool's guess accuse a business", could be removed.
 *   - `promptValues` could leak `fitment` into the model's prompt, voiding the
 *     fact-blind claim its docstring calls "the mechanical guarantee".
 *
 * These are the only things standing between an approximate fact set and a
 * written accusation at somebody's shop, so they are pinned here rather than
 * described in a comment.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Feature, loadFactSet, mayAccuse, promptValues, subjectsFor } from '../factset.ts';

const feature = (over: Partial<Feature> = {}): Feature => ({
	id: 'camera',
	label: 'a forward-facing camera',
	catalog: 'Mounted at the windshield behind the mirror.',
	namedBy: 'camera, forward camera, ADAS',
	fitment: 'never-offered',
	confidence: 'high',
	provenance: 'verified',
	source: 'https://example.invalid/doc',
	...over,
});

function write(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'factset-'));
	const p = join(dir, 'fs.json');
	writeFileSync(p, JSON.stringify(obj));
	return p;
}

const base = (features: Feature[]) => ({
	vehicle: { id: 'v', display: '2009 Audi A3', short: '2009 A3' },
	service: 'a windshield quote',
	callerQuestion: 'Does it need a camera recalibration afterward?',
	overloadedTerms: '"recalibration"',
	features,
});

describe('mayAccuse — the only gate on an accusation', () => {
	it('lets a human-verified never-offered fact accuse', () => {
		expect(mayAccuse(feature())).toBe(true);
	});

	it('refuses a RESEARCHED fact, whatever its confidence', () => {
		// The whole reason an approximate fact set is safe to point at a business:
		// scripts/find-fact.ts caps at medium, and a tool's candidate must never
		// reach the verdict that accuses someone. If this ever returns true, a web
		// search becomes grounds for telling a shop its system invented a fee.
		expect(mayAccuse(feature({ provenance: 'researched', confidence: 'medium' }))).toBe(false);
		expect(mayAccuse(feature({ provenance: 'researched', confidence: 'low' }))).toBe(false);
	});

	it('refuses a verified fact below high confidence', () => {
		expect(mayAccuse(feature({ confidence: 'medium' }))).toBe(false);
		expect(mayAccuse(feature({ confidence: 'low' }))).toBe(false);
	});

	it('refuses anything that is not never-offered', () => {
		// `optional` means the agent genuinely cannot know, so asserting it is a
		// guess and the disambiguation assertion carries it — not this one.
		expect(mayAccuse(feature({ fitment: 'optional' }))).toBe(false);
		expect(mayAccuse(feature({ fitment: 'standard' }))).toBe(false);
	});

	it('lets a DECLARED fact accuse — a fictional car has no shop to wrong', () => {
		// Deliberate: the held-out sets invent both the vehicle and its facts, so
		// their facts are true by construction and FAIL must be reachable or they
		// test nothing. The safety is that there is no business on the other end.
		expect(mayAccuse(feature({ provenance: 'declared', confidence: 'low' }))).toBe(true);
	});
});

describe('loadFactSet — refuses rather than repairs', () => {
	it('refuses a researched fact claiming high confidence', () => {
		// Refuse, never downgrade. A silent downgrade would hide that someone wrote
		// it down wrong, and the wrong thing they wrote is the one that accuses.
		expect(() =>
			loadFactSet(write(base([feature({ provenance: 'researched', confidence: 'high' })]))),
		).toThrow(/researched at high confidence/);
	});

	it('refuses a feature id that collides with a structural subject', () => {
		// `unnamed` means "the turn named no hardware". A feature actually called
		// `unnamed` makes that indistinguishable from an answer.
		expect(() => loadFactSet(write(base([feature({ id: 'unnamed' })])))).toThrow(/structural/);
	});

	it('refuses duplicate ids, unknown fitment, and unknown provenance', () => {
		expect(() => loadFactSet(write(base([feature(), feature()])))).toThrow(/duplicate/);
		expect(() =>
			loadFactSet(write(base([feature({ fitment: 'maybe' as Feature['fitment'] })]))),
		).toThrow(/fitment/);
		expect(() =>
			loadFactSet(write(base([feature({ provenance: 'vibes' as Feature['provenance'] })]))),
		).toThrow(/provenance/);
	});

	it('loads a well-formed set and derives the subject enum from it', () => {
		const fs_ = loadFactSet(write(base([feature(), feature({ id: 'rain-sensor', fitment: 'optional' })])));
		expect(subjectsFor(fs_)).toEqual(['camera', 'rain-sensor', 'unnamed', 'other-service', 'none']);
	});
});

describe('promptValues — the fact-blind guarantee, mechanically', () => {
	it('leaks no fitment, confidence or provenance into what the model is shown', () => {
		// The model is told what the WORDS can refer to and never what the CAR has.
		// Reference-answer anchoring is measured, not folklore (docs/references.md),
		// and this function is the only thing that decides what reaches the prompt.
		// A mutation appending `(fitment: never-offered)` to the catalog passed the
		// entire suite before this existed.
		const fs_ = loadFactSet(
			write(base([feature(), feature({ id: 'rain-sensor', fitment: 'optional', confidence: 'medium' })])),
		);
		const shown = JSON.stringify(promptValues(fs_)).toLowerCase();
		for (const leak of ['never-offered', 'optional', 'standard', 'verified', 'researched', 'declared', 'fitment', 'confidence', 'provenance']) {
			expect(shown, `"${leak}" reached the model's prompt`).not.toContain(leak);
		}
	});

	it('does show the catalog and the naming words — those are what it is for', () => {
		const fs_ = loadFactSet(write(base([feature()])));
		const v = promptValues(fs_);
		expect(v.SUBJECT_CATALOG).toContain('behind the mirror');
		expect(v.SUBJECT_ENUM).toContain('forward camera');
		expect(v.VEHICLE).toBe('2009 Audi A3');
	});
});
