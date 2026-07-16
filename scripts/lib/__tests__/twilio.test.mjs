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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDialAllowed, CALLS_ENDPOINT, placeCall } from '../twilio.ts';

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

describe('placeCall — the single dial primitive', () => {
	/** Stub fetch and record every request so we can assert whether a dial POST
	 * ever left. The ownership GET returns `owned`; a Calls.json POST returns a
	 * fake resource. */
	function stubDial(owned) {
		const seen = [];
		globalThis.fetch = vi.fn(async (url, opts) => {
			const u = String(url);
			seen.push({ url: u, method: opts?.method ?? 'GET', body: opts?.body?.toString() });
			if (u.includes('Calls.json')) {
				return {
					ok: true,
					status: 201,
					text: async () => JSON.stringify({ sid: 'CA1', status: 'queued' }),
				};
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ incoming_phone_numbers: owned }),
			};
		});
		return seen;
	}

	it('refuses a non-owned destination and never POSTs a dial', async () => {
		const seen = stubDial(OWNED);
		await expect(
			placeCall('ACx', 'tok', { to: '+17205551234', from: '+15042177595', twiml: '<Response/>' }),
		).rejects.toThrow(/not a number/);
		expect(seen.some((c) => c.url.includes('Calls.json'))).toBe(false);
	});

	it('refuses the system under test, and never POSTs a dial', async () => {
		const seen = stubDial(OWNED);
		process.env.CALLBENCH_TARGET_NUMBER = '+15042177595';
		await expect(
			placeCall('ACx', 'tok', { to: '+15042177595', from: '+15047663198', twiml: '<Response/>' }),
		).rejects.toThrow(/system under test/);
		expect(seen.some((c) => c.url.includes('Calls.json'))).toBe(false);
	});

	it('dials an owned destination through exactly one Calls.json POST, guard first', async () => {
		const seen = stubDial(OWNED);
		const res = await placeCall('ACx', 'tok', {
			to: '+15042177595',
			from: '+15047663198',
			twiml: '<Response/>',
		});
		expect(res.sid).toBe('CA1');
		const posts = seen.filter((c) => c.url.includes('Calls.json'));
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toContain('To=%2B15042177595'); // the dialed destination
		// The ownership guard ran before the dial (an IncomingPhoneNumbers GET precedes the POST).
		const dialAt = seen.findIndex((c) => c.url.includes('Calls.json'));
		expect(seen.slice(0, dialAt).some((c) => c.url.includes('IncomingPhoneNumbers.json'))).toBe(
			true,
		);
	});
});

describe('STRUCTURAL: exactly one dial site exists under scripts/', () => {
	// The dial guard is un-bypassable only if there is nowhere else to POST a
	// dial. `placeCall` (in lib/twilio.ts) folds the guard into the POST; this
	// asserts no other script constructs a placement request, so deleting a
	// guard call cannot reintroduce an unguarded dial. Mirrors the app and
	// runplan source-scan fences. (Poll/hang-up hit `/Calls/<sid>.json`, which is
	// not the placement endpoint and does not match either token.)
	//
	// TWO tokens, because one is evadable. The endpoint is imported from the
	// primitive rather than re-spelled here (AGENTS.md: single-source a name), but
	// a dialer that builds the path from parts — `['Calls','json'].join('.')` —
	// spells nothing this scan sees. `Twiml` closes that: it is the capital-T
	// parameter Twilio requires on a placement POST, it appears only at the dial
	// site, and every script names its own variable `twiml` in lowercase. A dialer
	// must name both to work and evade both to hide.
	//
	// Scope note (accepted, not fixed here): this fence walks scripts/ only.
	// packages/runplan and apps/web carry their own source-scan fences over their
	// own trees; a dial site added under some OTHER package is fenced by nothing
	// structural — only by the fact that the transport package is the sole holder
	// of credentials. A repo-wide fence is the right shape and is a maintainer
	// call, not a silent widening of this test's scope.
	const SCRIPTS = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // scripts/
	const PRIMITIVE = join(SCRIPTS, 'lib', 'twilio.ts');
	/** Tokens a placement POST cannot avoid naming. */
	const DIAL_TOKENS = [CALLS_ENDPOINT, 'Twiml'];

	function walk(dir) {
		const out = [];
		for (const name of readdirSync(dir)) {
			if (name === '__tests__' || name === 'node_modules') continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) out.push(...walk(p));
			else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
		}
		return out;
	}

	it('no file under scripts/ but lib/twilio.ts names a dial token', () => {
		const files = walk(SCRIPTS);
		expect(files.length).toBeGreaterThan(3); // guard against walking nothing
		const offenders = [];
		for (const f of files) {
			if (f === PRIMITIVE) continue;
			const src = readFileSync(f, 'utf8');
			for (const token of DIAL_TOKENS) if (src.includes(token)) offenders.push(`${f}: ${token}`);
		}
		expect(offenders).toEqual([]);
		// and the primitive really is the one place that names them
		const primitive = readFileSync(PRIMITIVE, 'utf8');
		for (const token of DIAL_TOKENS) expect(primitive).toContain(token);
	});
});
