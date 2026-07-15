/**
 * The single playback clock for a run's replay — ported from the maintainer's
 * own Svelte 5 + Web Audio engine (`~/Projects/separate`), which already solved
 * the hard parts: one persistent <audio> element, one AudioContext, one
 * AnalyserNode, created once and reused so switching runs never leaks contexts;
 * one rAF loop driving the reactive playhead `t` and a `frame` counter, so every
 * visual (waveform, transcript highlight, meter) reads one clock and cannot
 * drift; a wall-clock fallback so the playhead still animates if audio never
 * starts; and `playRegion(start, end)` — the centerpiece gesture, auditioning a
 * finding's span and pausing at its end.
 *
 * This engine RENDERS a frozen recording; it measures nothing. A level read here
 * is a property of the file, a duration a property of the decoder — neither may
 * ever become a figure in a report (ui.md, the two-pipelines rule).
 */

// --- global exclusive-audio bus: starting one source stops the previous ---
let currentStop: (() => void) | null = null;
export function claimAudio(stop: () => void) {
	if (currentStop && currentStop !== stop) currentStop();
	currentStop = stop;
}
export function releaseAudio(stop: () => void) {
	if (currentStop === stop) currentStop = null;
}

export class Transport {
	playing = $state(false);
	/** Current playback position in seconds. Read this for declarative bindings. */
	t = $state(0);
	duration = $state(0);
	/** Bumped once per rAF tick while playing. Depend on this for canvas redraws. */
	frame = $state(0);

	#raf = 0;
	#audio: HTMLAudioElement | null = null;
	#stopAt: number | null = null;
	/** canplay-time clock corrections since the last load/seek — see the cap. */
	#seekCorrections = 0;

	// Wall-clock fallback so the playhead animates even when audio never plays
	// (autoplay blocked, decode/codec failure, muted device). The clock free-runs
	// from these baselines and snaps to the audio element only while it is
	// genuinely progressing — see #tick.
	#clockBase = 0;
	#tBase = 0;
	#lastAudioTime = -1;

	// one shared analyser over the single audio element
	#ctx: AudioContext | null = null;
	#analyser: AnalyserNode | null = null;
	#freq: Uint8Array<ArrayBuffer> | null = null;
	#connected = false;
	#stop = () => this.pause();

	#ensureAudio(): HTMLAudioElement | null {
		if (this.#audio || typeof Audio === 'undefined') return this.#audio;
		const a = new Audio();
		a.preload = 'auto';
		a.addEventListener('ended', () => this.pause());
		a.addEventListener('error', () => this.pause()); // don't let the rAF loop spin on a media error
		a.addEventListener('loadedmetadata', () => {
			// The FROZEN duration passed to load() is authoritative for the timeline
			// (the waveform, playhead, and scrub max all scale off it). Only fall back
			// to the decoder's duration when we were given none — never override the
			// frozen value, or the one clock would scale off two disagreeing durations.
			if (this.#audio && this.duration === 0 && Number.isFinite(this.#audio.duration)) {
				this.duration = this.#audio.duration;
			}
		});
		// A seek or play() issued while the media load algorithm is in flight is
		// DISCARDED by the element when the load settles: load() queues its work
		// asynchronously, so playRegion racing it (the finding page's autoplay does
		// exactly this) seeks an element that is about to be reset to 0. Correcting
		// at 'loadedmetadata' is too early — the element's own seek-to-default step
		// runs right after it and wins (observed: a 28.4s write read back as 0).
		// 'canplay' is the first moment the element is genuinely seekable, so THAT
		// is where the transport re-asserts its clock: bring the element to `t`
		// (never the reverse) and restart the playback the load interrupted. The
		// 0.25s guard makes the mid-playback canplay (after any ordinary seek) a
		// no-op.
		a.addEventListener('canplay', () => {
			if (!this.#audio || !this.playing) return;
			if (Math.abs(this.#audio.currentTime - this.t) > 0.25) {
				// CAPPED: an element that refuses the seek (e.g. served without range
				// support it is unseekable and clamps every write to 0) re-fires
				// canplay after each rejected attempt — uncapped, that is an infinite
				// correction storm (observed). After the cap, the element is left
				// where it insists and the wall-clock fallback carries the playhead.
				if (this.#seekCorrections >= 3) return;
				this.#seekCorrections++;
				this.#audio.currentTime = this.t;
				this.#lastAudioTime = -1;
			}
			void this.#audio.play().catch(() => {});
		});
		this.#audio = a;
		return a;
	}

	/** Point the transport at a new run's audio. Reuses the same element/graph. */
	load(audioUrl: string, duration: number) {
		if (currentStop) currentStop();
		this.pause();
		this.duration = duration;
		this.t = 0;
		this.#seekCorrections = 0;
		const a = this.#ensureAudio();
		if (a) {
			a.src = audioUrl;
			a.load();
		}
	}

	/** Lazily build the WebAudio graph (must follow a user gesture). Connected once. */
	#ensureAnalyser() {
		if (this.#connected || !this.#audio || typeof AudioContext === 'undefined') return;
		this.#ctx = new AudioContext();
		const src = this.#ctx.createMediaElementSource(this.#audio);
		this.#analyser = this.#ctx.createAnalyser();
		this.#analyser.fftSize = 1024;
		this.#analyser.smoothingTimeConstant = 0.8;
		this.#freq = new Uint8Array(new ArrayBuffer(this.#analyser.frequencyBinCount));
		src.connect(this.#analyser);
		this.#analyser.connect(this.#ctx.destination);
		this.#connected = true;
	}

	/** Live frequency data from the shared analyser (or null before first play).
	 * For a live METER only — never a measured figure. */
	freq(): Uint8Array<ArrayBuffer> | null {
		if (!this.#analyser || !this.#freq) return null;
		this.#analyser.getByteFrequencyData(this.#freq);
		return this.#freq;
	}
	get sampleRate(): number {
		return this.#ctx?.sampleRate ?? 48000;
	}

	toggle() {
		if (this.playing) this.pause();
		else this.play();
	}

	play() {
		if (this.playing) return;
		claimAudio(this.#stop);
		this.#ensureAnalyser();
		void this.#ctx?.resume();
		this.#stopAt = null;
		if (this.t >= this.duration - 0.01) this.seek(0);
		this.playing = true;
		this.#resetClock(this.t);
		if (this.#audio) {
			this.#audio.currentTime = this.t;
			void this.#audio.play().catch(() => {});
		}
		this.#tick();
	}

	/** Play only [start, end] then pause — the centerpiece: audition a finding's
	 * span and stop at its end. */
	playRegion(start: number, end: number) {
		this.pause();
		claimAudio(this.#stop);
		this.#ensureAnalyser();
		void this.#ctx?.resume();
		this.seek(start);
		this.#stopAt = end;
		this.playing = true;
		this.#resetClock(start);
		if (this.#audio) {
			this.#audio.currentTime = start;
			void this.#audio.play().catch(() => {});
		}
		this.#tick();
	}

	pause() {
		this.playing = false;
		cancelAnimationFrame(this.#raf);
		this.#audio?.pause();
		releaseAudio(this.#stop);
	}

	seek(t: number) {
		const clamped = Math.max(0, Math.min(this.duration, t));
		this.t = clamped;
		this.#seekCorrections = 0; // a fresh intent re-arms the canplay correction
		this.#resetClock(clamped);
		if (this.#audio) this.#audio.currentTime = clamped;
	}

	/** Re-anchor the wall-clock fallback so it free-runs from position `t`. */
	#resetClock(t: number) {
		this.#tBase = t;
		this.#clockBase = typeof performance !== 'undefined' ? performance.now() : 0;
		this.#lastAudioTime = -1;
	}

	#tick = () => {
		const now = typeof performance !== 'undefined' ? performance.now() : this.#clockBase;
		const a = this.#audio;
		// Trust the audio element only while it is actually advancing; otherwise the
		// clock free-runs on wall time so the playhead never stalls at 0:00.
		const audioLive = !!a && !a.paused && a.readyState >= 2 && a.currentTime > this.#lastAudioTime;
		if (audioLive && a) {
			this.t = a.currentTime;
			this.#lastAudioTime = a.currentTime;
			this.#tBase = a.currentTime;
			this.#clockBase = now;
		} else {
			this.t = Math.min(this.duration, this.#tBase + (now - this.#clockBase) / 1000);
		}
		this.frame++;
		if (this.#stopAt != null && this.t >= this.#stopAt) {
			this.#stopAt = null;
			this.pause();
			return;
		}
		if (this.t >= this.duration - 0.01) {
			this.pause();
			return;
		}
		this.#raf = requestAnimationFrame(this.#tick);
	};

	/**
	 * Tear down and RESET to a fresh state. Reinitializable on purpose: a
	 * component that is reused across navigations may call this on unmount and
	 * then be reused; without the reset, a later play() would early-return in
	 * #ensureAnalyser (still `#connected`) and resume() a closed context — silent
	 * playback. Dropping the element too matters: an <audio> element can be wired
	 * to `createMediaElementSource` only once ever, so a rebuilt graph needs a
	 * fresh element. After destroy(), the next load()/play() rebuilds everything.
	 */
	destroy() {
		this.pause();
		if (this.#audio) this.#audio.src = '';
		void this.#ctx?.close();
		this.#ctx = null;
		this.#analyser = null;
		this.#freq = null;
		this.#connected = false;
		this.#audio = null;
		this.#lastAudioTime = -1;
	}
}
