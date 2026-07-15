/**
 * Shared Twilio plumbing for operator scripts: env, auth, API calls, and the
 * dial guard every script that places a call must pass through.
 */

const API = 'https://api.twilio.com/2010-04-01';

export function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set. Run with --env-file=.env`);
	return v;
}

export function requireAccountSid(): string {
	const sid = required('TWILIO_ACCOUNT_SID');
	if (!sid.startsWith('AC')) {
		throw new Error(
			`TWILIO_ACCOUNT_SID must be the Account SID (starts with AC), got "${sid.slice(0, 2)}...". ` +
				'An SK value is an API Key SID — these scripts authenticate with the Account SID and Auth Token.',
		);
	}
	return sid;
}

export async function twilioApi(
	sid: string,
	token: string,
	path: string,
	body?: URLSearchParams,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
			...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
		},
		body,
	});
	const text = await res.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}: ${parsed.message ?? text}`);
	return parsed;
}

/** Phone-number comparison that survives formatting drift: digits only. */
function digits(n: string): string {
	return n.replace(/[^0-9]/g, '');
}

/**
 * The dial guard. Every script that places a call calls this with the
 * destination FIRST, and dials only what it returns.
 *
 * The rule it enforces is ownership, not a deny-list: **a script may dial only
 * a number this account owns.** That single check is what makes the guard
 * un-no-op-able — an earlier version compared the destination against
 * CALLBENCH_TARGET_NUMBER and silently passed whenever that variable was
 * unset, and compared with `===` so a formatting difference slipped it. The
 * ownership check has no unset case: the account's number list comes from the
 * API on every call, and if the destination isn't in it, there is no dial.
 *
 * The explicit target check stays as a second fence with a clearer message
 * (and digit-normalized comparison), because "you are about to dial the
 * system under test" is worth saying precisely when it is the error.
 *
 * Returns Twilio's canonical E.164 for the destination.
 */
export async function assertDialAllowed(sid: string, token: string, to: string): Promise<string> {
	const target = process.env.CALLBENCH_TARGET_NUMBER;
	if (target && digits(to) === digits(target)) {
		throw new Error(
			`Refusing to dial ${to}: it is the system under test. ` +
				'Bench scripts dial owned numbers only; the target path is the live-call skill, human-gated dial by dial.',
		);
	}
	const res = await twilioApi(sid, token, `/Accounts/${sid}/IncomingPhoneNumbers.json`);
	const owned = (res.incoming_phone_numbers ?? []) as Array<Record<string, unknown>>;
	const match = owned.find((n) => digits(String(n.phone_number)) === digits(to));
	if (!match) {
		const list = owned.map((n) => n.phone_number).join(', ') || '(none)';
		throw new Error(
			`Refusing to dial ${to}: not a number this account owns. Owned: ${list}. ` +
				'Bench scripts dial owned numbers only — no exceptions, no flag.',
		);
	}
	return String(match.phone_number);
}

/** Best-effort hang-up; never throws. For finally-blocks and signal handlers. */
export async function hangUp(sid: string, token: string, callSid: string): Promise<void> {
	await twilioApi(
		sid,
		token,
		`/Accounts/${sid}/Calls/${callSid}.json`,
		new URLSearchParams({ Status: 'completed' }),
	).catch(() => {});
}
