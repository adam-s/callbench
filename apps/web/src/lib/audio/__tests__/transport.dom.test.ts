/**
 * Transport engine tests (jsdom + Svelte runes). These pin the lifecycle bugs a
 * red-team pass found — the ones a server-only suite could not see:
 *
 *   - destroy() must RESET the engine so a reused instance rebuilds its graph.
 *     The bug: destroy() closed the AudioContext but left `#connected`/`#audio`
 *     set, so the next play() resumed a CLOSED context and was silently mute —
 *     which broke the "hear that moment" centerpiece from the second navigation
 *     on. The detector: a second play() after destroy() must build a NEW context.
 *   - the exclusive-audio bus: starting one transport stops the previous.
 *   - playRegion/seek set the expected state and clamp to the timeline.
 *
 * The Web Audio + media APIs are faked so the state machine runs deterministically
 * without a real browser; rAF is stubbed to NOT auto-advance, so `playing` stays
 * put until we act.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transport } from '../transport.svelte.ts';

class FakeAudioContext {
	static count = 0;
	state: 'running' | 'closed' = 'running';
	sampleRate = 48000;
	destination = {};
	constructor() {
		FakeAudioContext.count++;
	}
	createMediaElementSource(el: { __connected?: boolean }) {
		// A real <audio> element can be wired to a source node only once, ever.
		if (el.__connected) throw new Error('MediaElementSource already created for this element');
		el.__connected = true;
		return { connect() {} };
	}
	createAnalyser() {
		return {
			fftSize: 0,
			smoothingTimeConstant: 0,
			frequencyBinCount: 512,
			connect() {},
			getByteFrequencyData() {},
		};
	}
	resume() {
		if (this.state === 'closed') return Promise.reject(new Error('context is closed'));
		return Promise.resolve();
	}
	close() {
		this.state = 'closed';
		return Promise.resolve();
	}
}

class FakeAudio {
	src = '';
	currentTime = 0;
	paused = true;
	readyState = 4;
	duration = Number.NaN;
	preload = '';
	__connected = false;
	addEventListener() {}
	load() {}
	play() {
		this.paused = false;
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
}

beforeEach(() => {
	FakeAudioContext.count = 0;
	vi.stubGlobal('AudioContext', FakeAudioContext);
	vi.stubGlobal('Audio', FakeAudio);
	// rAF stubbed to NOT run the tick loop — the state under test is set
	// synchronously by play/pause/seek, and a live loop would race the assertions.
	vi.stubGlobal('requestAnimationFrame', () => 1);
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('destroy() is reinitializable — the centerpiece survives navigation', () => {
	it('rebuilds a fresh AudioContext after destroy, instead of resuming a closed one', () => {
		const t = new Transport();
		t.load('/a/audio', 10);
		t.play();
		expect(t.playing).toBe(true);
		expect(FakeAudioContext.count).toBe(1);

		t.destroy();

		// Reuse the SAME instance (as SvelteKit does across navigations).
		t.load('/a/audio', 10);
		t.play();
		expect(t.playing).toBe(true); // not silently mute
		expect(FakeAudioContext.count).toBe(2); // a NEW context — proves the reset
	});
});

describe('the exclusive-audio bus', () => {
	it('starting one transport stops the previously playing one', () => {
		const a = new Transport();
		const b = new Transport();
		a.load('/a/audio', 10);
		a.play();
		expect(a.playing).toBe(true);

		b.load('/b/audio', 10);
		b.play();
		expect(b.playing).toBe(true);
		expect(a.playing).toBe(false); // b claimed the bus, a was stopped
	});
});

describe('playRegion and seek', () => {
	it('playRegion seeks to the start and marks playing', () => {
		const t = new Transport();
		t.load('/a/audio', 10);
		t.playRegion(2, 4);
		expect(t.playing).toBe(true);
		expect(t.t).toBe(2);
	});

	it('seek clamps to the timeline', () => {
		const t = new Transport();
		t.load('/a/audio', 10);
		t.seek(100);
		expect(t.t).toBe(10);
		t.seek(-5);
		expect(t.t).toBe(0);
	});
});
