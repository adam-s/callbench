/**
 * The dial guard is the repo's single most safety-critical piece of logic:
 * it is what stops a script from calling a number it shouldn't. It lived
 * untested until a mutation survived — deleting its ownership check left the
 * suite green — so this pins it.
 *
 * `.mjs` because the suite globs scripts as `scripts/⁎⁎/⁎.test.mjs`; it imports
 * the `.ts` source through vitest's transform. `fetch` is stubbed so the test
 * never touches the network (the suite invariant).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDialAllowed } from '../twilio.ts';

const OWNED = [{ phone_number: '+15042177595' }, { phone_number: '+15047663198' }];

function stubOwnedNumbers(owned) {
	globalThis.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ incoming_phone_numbers: owned }),
	}));
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.CALLBENCH_TARGET_NUMBER;
});

describe('assertDialAllowed — the dial guard', () => {
	it('allows a number the account owns', async () => {
		stubOwnedNumbers(OWNED);
		await expect(assertDialAllowed('ACx', 'tok', '+15042177595')).resolves.toBe('+15042177595');
	});

	it('allows an owned number given in a different format (digits-only compare)', async () => {
		stubOwnedNumbers(OWNED);
		await expect(assertDialAllowed('ACx', 'tok', '15042177595')).resolves.toBe('+15042177595');
	});

	it('REJECTS a number the account does not own — even with the target env unset', async () => {
		stubOwnedNumbers(OWNED);
		// This is the exact hole a mutation exposed: the old guard only compared
		// against CALLBENCH_TARGET_NUMBER and passed when that was unset. The
		// ownership check has no unset case.
		await expect(assertDialAllowed('ACx', 'tok', '+17205551234')).rejects.toThrow(/not a number/);
	});

	it('REJECTS the system under test, named as such', async () => {
		stubOwnedNumbers(OWNED);
		process.env.CALLBENCH_TARGET_NUMBER = '+15042177595';
		await expect(assertDialAllowed('ACx', 'tok', '+15042177595')).rejects.toThrow(
			/system under test/,
		);
	});

	it('REJECTS the target even when its format differs from the env value', async () => {
		stubOwnedNumbers(OWNED);
		process.env.CALLBENCH_TARGET_NUMBER = '15042177595'; // no +
		await expect(assertDialAllowed('ACx', 'tok', '+15042177595')).rejects.toThrow(
			/system under test/,
		);
	});

	it('REJECTS when the account owns nothing', async () => {
		stubOwnedNumbers([]);
		await expect(assertDialAllowed('ACx', 'tok', '+15042177595')).rejects.toThrow(
			/Owned: \(none\)/,
		);
	});
});
