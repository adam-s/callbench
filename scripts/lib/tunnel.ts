/**
 * Cloudflared quick-tunnel helper, shared by every script that needs Twilio to
 * reach this machine. The knowledge in here was paid for with a wasted call
 * and four failed probe runs — read the comments before "simplifying".
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

/**
 * Wait this long after the tunnel prints its URL before touching DNS at all.
 *
 * This looks like a superstitious sleep. It is not, and removing it will break
 * the caller in a way that takes an hour to diagnose. Measured 2026-07-15:
 *
 * cloudflared prints the public URL ~20s before the tunnel is registered — its
 * own banner says "it may take some time to be reachable", and its logs show
 * QUIC connecting ~11s and prechecks passing ~21s AFTER the URL appears.
 *
 * The trap: if you ask a resolver for the hostname during that window, it gets
 * NXDOMAIN and **caches the negative answer** for the zone's TTL. Every later
 * query is then served the cached "does not exist" — so a readiness check that
 * polls eagerly *causes* the failure it is trying to detect. Measured both
 * ways: polling from t+0 still failed at t+40s; waiting 35s and asking once
 * succeeded immediately, on every resolver tried.
 */
export const TUNNEL_SETTLE_MS = 35_000;

/** How long to keep checking after the settle wait, before giving up. */
export const TUNNEL_READY_MS = 60_000;

export interface Tunnel {
	readonly host: string;
	stop(): void;
}

/** Start a quick tunnel to localhost:port and resolve its public hostname. */
export function startTunnel(port: number, urlWaitMs = 25_000): Promise<Tunnel> {
	return new Promise((resolve, reject) => {
		const proc = spawn('cloudflared', [
			'tunnel',
			'--url',
			`http://localhost:${port}`,
			'--no-autoupdate',
		]);
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`cloudflared printed no URL within ${urlWaitMs / 1000}s`));
		}, urlWaitMs);

		// cloudflared announces the URL on stderr, not stdout.
		const onData = (chunk: Buffer) => {
			const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(chunk.toString());
			if (m?.[1]) {
				clearTimeout(timer);
				resolve({ host: m[1], stop: () => proc.kill() });
			}
		};
		proc.stderr.on('data', onData);
		proc.stdout.on('data', onData);
		proc.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

/**
 * Settle, then verify the tunnel actually carries a WebSocket, using the OS
 * resolver deliberately (a forced-public-DNS variant existed and was both
 * unnecessary and buggy — see docs/references.md, tunnel section).
 *
 * Returns seconds waited after the settle, or null if it never came up. The
 * caller decides what null means; for anything that would dial a phone, null
 * means DO NOT DIAL.
 */
export async function waitForTunnel(host: string, readyPath: string): Promise<number | null> {
	console.log(`settle : waiting ${TUNNEL_SETTLE_MS / 1000}s before the first DNS query`);
	await new Promise((r) => setTimeout(r, TUNNEL_SETTLE_MS));

	const started = Date.now();
	while (Date.now() - started < TUNNEL_READY_MS) {
		const open = await new Promise<boolean>((resolve) => {
			const ws = new WebSocket(`wss://${host}${readyPath}`);
			const finish = (ok: boolean) => {
				try {
					ws.close();
				} catch {
					/* already closed */
				}
				resolve(ok);
			};
			const t = setTimeout(() => finish(false), 4000);
			ws.on('open', () => {
				clearTimeout(t);
				finish(true);
			});
			ws.on('error', () => {
				clearTimeout(t);
				finish(false);
			});
		});
		if (open) return (Date.now() - started) / 1000;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return null;
}
