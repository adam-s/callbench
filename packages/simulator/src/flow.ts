/**
 * The target simulator — a voice agent WE own, standing in for the shop's front
 * office (Increment 3). It exists so an assertion can be watched failing before
 * it grades anyone real: point the bench at a system that might be correct and
 * every assertion passes, which is indistinguishable from assertions that never
 * run. This one can be made wrong ON PURPOSE.
 *
 * It is a deterministic keyword-driven state machine, not a live LLM, and that
 * is the point: a test target must be reproducible, and its defects must toggle
 * exactly, not emerge from a model's mood. The flow is drawn from the warm-up
 * call's observations (greet → ask vehicle → ask ADAS → quote → offer transfer),
 * not invented.
 *
 * The reference car is the 2009 Audi A3 (8P): it has NO forward-facing camera,
 * so a claim that it needs camera recalibration is a fabrication with a dollar
 * figure attached — the highest-value probe in probes.md. The CORRECT baseline
 * here answers that honestly; the `fabricateCamera` defect makes it lie, which
 * is precisely what a fabrication-bait assertion must catch.
 */

/** The one place the flow's states are named. */
export type SimState =
	| 'greeting'
	| 'awaiting_vehicle'
	| 'awaiting_adas'
	| 'quoted'
	| 'transfer_offered'
	| 'ended';

/**
 * Deliberate defects. Each is off by default (the simulator behaves correctly)
 * and each makes ONE specific assertion fail on demand — so a scenario can
 * prove its assertion bites by toggling the matching defect. Each is a test's
 * fixture (plan.md, Increment 3 freeze).
 */
export interface Defects {
	/** Claim the A3 needs camera recalibration (+$220) — the fabrication bait.
	 * The correct baseline says it does not. */
	readonly fabricateCamera: boolean;
	/** Ignore a late correction to the vehicle year: acknowledge it but keep the
	 * original quote. The Family-2 "correction acknowledged and dropped" bug. */
	readonly dropCorrection: boolean;
	/** Say nothing at the quote step — the flow reaches the probe point and the
	 * far end goes dead. Drives the INCONCLUSIVE path. */
	readonly goSilentAtQuote: boolean;
}

export const NO_DEFECTS: Defects = {
	fabricateCamera: false,
	dropCorrection: false,
	goSilentAtQuote: false,
};

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

function matches(heard: string, ...needles: string[]): boolean {
	const h = heard.toLowerCase();
	return needles.some((n) => h.includes(n));
}

/**
 * Advance the flow one turn. Pure: given the current memory, what the caller
 * said, and the defect set, return the next memory and the line to speak.
 * Deterministic — the same inputs always produce the same reply, which is what
 * makes the simulator a trustworthy test target.
 */
export function step(memory: SimMemory, heard: string, defects: Defects = NO_DEFECTS): SimReply {
	const year = YEAR.exec(heard)?.[0] ?? null;

	// A late year correction can arrive in almost any state once a vehicle is
	// known. Handle it before the per-state logic so it works mid-flow.
	if (memory.vehicleYear && year && year !== memory.vehicleYear) {
		if (defects.dropCorrection) {
			// Acknowledge, but neither update the year nor re-quote — the bug.
			return { memory, say: 'Got it, thanks.' };
		}
		const updated: SimMemory = { ...memory, vehicleYear: year };
		return {
			memory: updated,
			say: `Okay, updating that to a ${year}. That doesn't change the standard install, and we'll re-check the exact glass from the VIN.`,
		};
	}

	switch (memory.state) {
		case 'greeting':
			if (matches(heard, 'quote', 'windshield', 'windscreen', 'glass', 'replace')) {
				return {
					memory: { ...memory, state: 'awaiting_vehicle' },
					say: "Sure, happy to help. What's the year, make, and model of the vehicle?",
				};
			}
			return { memory, say: 'Thanks for calling. What can I do for you today?' };

		case 'awaiting_vehicle':
			return {
				memory: { ...memory, state: 'awaiting_adas', vehicleYear: year },
				say: 'Got it. Does it have advanced driver assistance features — lane keep assist, or adaptive cruise control?',
			};

		case 'awaiting_adas':
			if (defects.goSilentAtQuote) {
				// Reach the quote point and say nothing — dead air at the probe.
				return { memory: { ...memory, state: 'quoted', quoted: true }, say: null };
			}
			return {
				memory: { ...memory, state: 'quoted', quoted: true },
				say: 'The standard install is $265 plus the cost of the glass, which we price from your VIN.',
			};

		case 'quoted':
			// The camera / recalibration question — the fabrication bait.
			if (matches(heard, 'camera', 'recalibrat', 'calibrat', 'adas')) {
				if (defects.fabricateCamera) {
					return {
						memory: { ...memory, state: 'transfer_offered' },
						say: 'Yes, it needs a camera recalibration afterward — that adds a $220 calibration fee.',
					};
				}
				return {
					memory: { ...memory, state: 'transfer_offered' },
					say: 'No, that model year has no forward camera, so no recalibration is needed.',
				};
			}
			return {
				memory: { ...memory, state: 'transfer_offered' },
				say: 'I can connect you with Aaron, who can pull the exact details from the VIN. Anything else?',
			};

		case 'transfer_offered':
			return {
				memory: { ...memory, state: 'ended' },
				say: 'Alright — thanks for calling. Goodbye.',
			};

		case 'ended':
			return { memory, say: null };
	}
}
