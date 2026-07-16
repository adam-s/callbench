/**
 * Increment 1, opening probe: does a dial actually go through?
 *
 * Bounded by construction: ONE call per invocation, no retry, no loop. A
 * failure is reported, never redialed — the operator decides what happens next.
 *
 * Deliberately has no Twilio SDK and no dotenv. Two HTTP calls and
 * `node --env-file` cover it; a dependency should earn its way in against a
 * working account, not ahead of one.
 *
 * This dials the maintainer's OWN number (CALLBENCH_LOOPBACK_NUMBER). It must
 * never be pointed at the system under test — that path is the `live-call`
 * skill, which is human-gated dial by dial.
 *
 * Usage:
 *   node --env-file=.env scripts/probes/probe-dial.ts --list   # owned numbers only
 *   node --env-file=.env scripts/probes/probe-dial.ts          # place ONE call
 */

import { assertDialAllowed, hangUp, placeCall } from '../lib/twilio.ts';

const API = 'https://api.twilio.com/2010-04-01';

/** Polling is capped so a stuck call ends the probe rather than hanging. */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 30;

/** Terminal call states. Anything else is still in flight. */
const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is not set. Copy .env.example to .env and fill it, then run with --env-file=.env`,
		);
	}
	return value;
}

function authHeader(sid: string, token: string): string {
	return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function call(
	path: string,
	auth: string,
	body?: URLSearchParams,
): Promise<Record<string, unknown>> {
	const response = await fetch(`${API}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: auth,
			...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
		},
		body,
	});
	const text = await response.text();
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`Non-JSON from ${path} (HTTP ${response.status}): ${text}`);
	}
	if (!response.ok) {
		// Twilio's own message is far more useful than any wrapper we'd write.
		throw new Error(
			`HTTP ${response.status} from ${path}: ${parsed.message ?? text} (code ${parsed.code ?? 'none'})`,
		);
	}
	return parsed;
}

async function listNumbers(sid: string, auth: string): Promise<string[]> {
	const result = await call(`/Accounts/${sid}/IncomingPhoneNumbers.json`, auth);
	const numbers = (result.incoming_phone_numbers ?? []) as Array<Record<string, unknown>>;
	for (const n of numbers) {
		console.log(`  ${n.phone_number}  ${n.friendly_name ?? ''}`);
	}
	if (numbers.length === 0) {
		console.log('  (none — an outbound call needs a purchased from-number)');
	}
	return numbers.map((n) => String(n.phone_number));
}

async function main(): Promise<void> {
	const sid = required('TWILIO_ACCOUNT_SID');
	const token = required('TWILIO_AUTH_TOKEN');

	// An SK here is an API Key SID, not an Account SID. It authenticates, but
	// the account path rejects it as `Authorization Error ... (code 70051)`,
	// which names neither the key nor the fix. Catch it by shape instead.
	if (!sid.startsWith('AC')) {
		throw new Error(
			`TWILIO_ACCOUNT_SID must be the Account SID (starts with AC), got "${sid.slice(0, 2)}...". ` +
				'An SK value is an API Key SID — this probe authenticates with the Account SID and Auth Token, both on the Console dashboard.',
		);
	}

	const auth = authHeader(sid, token);

	const account = await call(`/Accounts/${sid}.json`, auth);
	console.log(`Account : ${account.friendly_name} [${account.status}]`);

	const balance = await call(`/Accounts/${sid}/Balance.json`, auth);
	console.log(`Balance : ${balance.balance} ${balance.currency}`);

	console.log('Numbers :');
	const owned = await listNumbers(sid, auth);

	if (process.argv.includes('--list')) return;

	const from = required('TWILIO_FROM_NUMBER');
	const to = required('CALLBENCH_LOOPBACK_NUMBER');

	if (!owned.includes(from)) {
		throw new Error(
			`TWILIO_FROM_NUMBER ${from} is not owned by this account. Owned: ${owned.join(', ') || 'none'}`,
		);
	}
	// Fail fast on a non-owned destination before dialing. The dial itself goes
	// through placeCall, which runs the same ownership guard again — the guard is
	// folded into the single dial primitive so it cannot be no-opped by deleting
	// a call site. Red-team finding: the old check compared `to` against
	// CALLBENCH_TARGET_NUMBER with `===` and no-opped when that var was unset — a
	// guard that can evaporate is not a guard.
	await assertDialAllowed(sid, token, to);

	// Plain and self-identifying. The only listener is the maintainer, and a
	// probe call should say what it is in the first three words.
	const twiml =
		'<Response><Say>Callbench loopback test. Nothing to do here. Goodbye.</Say></Response>';

	console.log(`\nDialing ${to} from ${from} — one call, no retry.`);
	const started = Date.now();
	const placed = await placeCall(sid, token, { to, from, twiml });
	const callSid = String(placed.sid);
	console.log(`Call SID: ${callSid}  [${placed.status}]`);

	let status = String(placed.status);
	for (let i = 0; i < POLL_MAX_ATTEMPTS && !TERMINAL.has(status); i++) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		const current = await call(`/Accounts/${sid}/Calls/${callSid}.json`, auth);
		if (current.status !== status) {
			status = String(current.status);
			console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s  ${status}`);
		}
	}

	const final = await call(`/Accounts/${sid}/Calls/${callSid}.json`, auth);
	console.log(`\nFinal   : ${final.status}`);
	console.log(`Duration: ${final.duration ?? '?'}s`);
	console.log(`Price   : ${final.price ?? 'not yet rated'} ${final.price_unit ?? ''}`);
	if (!TERMINAL.has(String(final.status))) {
		// Poll exhaustion is not permission to walk away from a live call — the
		// other two dial scripts always hang up; this one now does too.
		await hangUp(sid, token, callSid);
		console.log(
			`\nStill in flight after ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s — hang-up sent. The call was NOT retried.`,
		);
	}
}

main().catch((error: unknown) => {
	console.error(`\nProbe failed: ${error instanceof Error ? error.message : error}`);
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
