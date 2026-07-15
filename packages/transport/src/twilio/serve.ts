/**
 * Network glue: an HTTP + WebSocket endpoint that hands each incoming Twilio
 * Media Stream to `createTwilioSession`.
 *
 * Deliberately the thinnest possible layer, because the suite never touches
 * the network — everything with behavior lives in session.ts and is tested
 * against fixtures through the MediaSocket seam. This file is exercised live
 * by the loopback runs, not by unit tests; keep it too small to hide a bug.
 *
 * Routes are a path→handler map because a loopback run hosts BOTH legs of a
 * call in one process on one tunnel: the bench's stream on one path, the
 * simulator's on another — which is also what puts both legs on one clock.
 */

import { createServer, type Server } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { TransportSession } from '../contract.ts';
import { createTwilioSession, type MediaSocket, type TwilioSessionOptions } from './session.ts';

export function wsToMediaSocket(ws: WebSocket): MediaSocket {
	return {
		send: (text) => ws.send(text),
		close: () => ws.close(),
		onMessage: (cb) => ws.on('message', (data) => cb(data.toString())),
		onClose: (cb) => ws.on('close', cb),
		onError: (cb) => ws.on('error', cb),
	};
}

export interface MediaRoute {
	onSession: (session: TransportSession) => void;
	/** Handshake failures land here — a refused session must be visible to the
	 * operator, never swallowed. */
	onSessionError: (err: Error) => void;
	sessionOptions?: TwilioSessionOptions;
}

export interface MediaEndpoint {
	readonly server: Server;
	close(): Promise<void>;
}

export function serveTwilioMedia(opts: {
	port: number;
	routes: Record<string, MediaRoute>;
}): Promise<MediaEndpoint> {
	const server = createServer();
	const wss = new WebSocketServer({ server });

	wss.on('connection', (ws, req) => {
		const route = opts.routes[req.url ?? ''];
		if (!route) {
			ws.close();
			return;
		}
		createTwilioSession(wsToMediaSocket(ws), route.sessionOptions).then(
			route.onSession,
			route.onSessionError,
		);
	});

	return new Promise((resolve) => {
		server.listen(opts.port, () =>
			resolve({
				server,
				close: () =>
					new Promise<void>((r) => {
						wss.close();
						server.close(() => r());
					}),
			}),
		);
	});
}
