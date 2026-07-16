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
		// Bounded (red-team 07-16): placeCall and the recording retry run before
		// the driver's wall cap is armed, so an unbounded provider fetch there
		// hung a standalone run with nothing to stop it.
		signal: AbortSignal.timeout(30_000),
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
			...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
		},
		body,
	});
	const text = await res.text();
	// Check the status BEFORE parsing, and never let a parse failure eat the
	// diagnosis. Twilio answers a bad gateway with an HTML page, so `JSON.parse`
	// first threw `SyntaxError: Unexpected token '<'` — no status, no endpoint, no
	// error code — during a LIVE CALL, which is exactly when the operator must be
	// able to tell what happened without dialing a stranger's line again to find
	// out (AGENTS.md: surface interventions; never silently retry).
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// leave null — the body is not JSON, which is itself the finding
	}
	if (!res.ok) {
		// Twilio's numeric `code` is the field its error docs are indexed by; it is
		// the difference between "look up 31931" and "read a stack trace".
		const code = parsed?.code !== undefined ? ` [Twilio ${parsed.code}]` : '';
		const detail = parsed?.message ?? text.slice(0, 300).replace(/\s+/g, ' ').trim();
		throw new Error(`HTTP ${res.status} from ${path}${code}: ${detail}`);
	}
	if (parsed === null)
		throw new Error(
			`non-JSON body from ${path} (HTTP ${res.status}): ${text.slice(0, 300).replace(/\s+/g, ' ').trim()}`,
		);
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
				'Bench scripts dial owned numbers only; the target path is the bench-live-call skill, human-gated dial by dial.',
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

/**
 * The call-placement endpoint, named once. The dial fence imports this token
 * rather than re-spelling it, so the fence and the dial site cannot drift apart
 * — and a rogue dialer under scripts/ has to name the same string the fence
 * scans for. (`/Calls/<sid>.json`, the poll and hang-up path, is a different
 * endpoint and deliberately not this token.)
 *
 * A constant is not a wall: a dialer that assembles the path from parts spells
 * nothing the fence sees, which is why the fence also scans for `Twiml` — the
 * capital-T API parameter a placement POST cannot omit and no script names.
 * Two independent tokens, both of which a dial needs.
 */
export const CALLS_ENDPOINT = 'Calls.json';

/**
 * The one place in the repo that can POST a dial. Every script that places a
 * call goes through here, and this awaits the dial guard FIRST — the guard is
 * folded into the primitive so it is inseparable from the POST. A prior design
 * had each script call `assertDialAllowed` and then POST the endpoint itself,
 * which meant deleting the guard line left a script that dials unguarded (and
 * the suite green). Here there is no un-guarded POST to reach: refuse first,
 * dial only what the guard returns as owned.
 *
 * `to` is dialed as the caller supplied it (the guard has already confirmed the
 * account owns it); `from` and `twiml` are the call's other two required params.
 * Returns Twilio's Calls resource. A structural test asserts no other file under
 * scripts/ names `CALLS_ENDPOINT` or `Twiml`, so this stays the only dial site.
 */
export async function placeCall(
	sid: string,
	token: string,
	params: { to: string; from: string; twiml: string },
): Promise<Record<string, unknown>> {
	await assertDialAllowed(sid, token, params.to);
	return twilioApi(
		sid,
		token,
		`/Accounts/${sid}/${CALLS_ENDPOINT}`,
		new URLSearchParams({ To: params.to, From: params.from, Twiml: params.twiml }),
	);
}

/**
 * The ONE way a call reaches the system under test — the inverse of
 * `assertDialAllowed`, in the same fence-pinned file (the structural test
 * pins this file as the only dial site). Three refusals, each load-bearing:
 *
 *   - the destination must EQUAL the configured target, digits-normalized —
 *     this primitive can dial nothing else, so a bug elsewhere cannot point
 *     it at an arbitrary stranger;
 *   - the confirmation must be the exact string "DIAL <last4>" for THIS
 *     target — the driver reads it from an interactive TTY at the moment of
 *     the dial, so a human's keystrokes are the ignition; nothing a loop,
 *     flag, or env var can supply (the driver additionally refuses to run
 *     without a TTY);
 *   - one POST, no retry: the caller gets one Calls resource or one error.
 *
 * The human checkpoint invariant (AGENTS.md) is implemented here, not
 * described: unattended paths use `placeCall`, which refuses this number by
 * name. See .agents/skills/bench-live-call.
 */
export async function dialSystemUnderTest(
	sid: string,
	token: string,
	params: { to: string; from: string; twiml: string; confirmation: string },
): Promise<Record<string, unknown>> {
	const target = process.env.CALLBENCH_TARGET_NUMBER;
	if (!target)
		throw new Error('CALLBENCH_TARGET_NUMBER is not set; there is no system under test.');
	if (digits(params.to) !== digits(target)) {
		throw new Error(
			`Refusing: dialSystemUnderTest dials ONLY the configured system under test, not ${params.to}.`,
		);
	}
	const expected = `DIAL ${digits(target).slice(-4)}`;
	if (params.confirmation !== expected) {
		throw new Error(
			`Refusing: the typed confirmation did not match. A human types "${expected}" at the prompt; nothing else starts this dial.`,
		);
	}
	return twilioApi(
		sid,
		token,
		`/Accounts/${sid}/${CALLS_ENDPOINT}`,
		new URLSearchParams({ To: params.to, From: params.from, Twiml: params.twiml }),
	);
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
