/**
 * Shared fixtures — the same agent turns and persona every contender faces, so
 * the comparison is fair. Drawn from the warm-up call's real shop flow so the
 * latency is measured on realistic conversational turns, not toy phrases.
 */

import type { TurnFixture } from './contract.ts';

export const WINDSHIELD_QUOTE: TurnFixture = {
	name: 'windshield-quote',
	// What the far-end shop agent says each turn; the pipeline hears these and
	// must reply as the caller. Lengths vary on purpose — a short greeting and a
	// long quote-plus-question stress first-audio differently.
	agentTurns: [
		'Hi, thanks for calling. How can I help you today?',
		"Sure, I can help with that. What's the year, make, and model of the vehicle?",
		'Got it. Does it have any driver-assistance features, like lane keep assist or adaptive cruise?',
		'The standard install is $265 plus the cost of the glass, which we price from your VIN.',
		'Alright — anything else I can help you with today?',
	],
	personaGoal: 'Get a price quote for replacing the windshield on your car.',
	personaFacts: [
		'Your car is a 2009 Audi A3.',
		'As far as you know it has no driver-assistance features.',
		'You are price-shopping, not booking today.',
	],
};

export const FIXTURES: readonly TurnFixture[] = [WINDSHIELD_QUOTE];
