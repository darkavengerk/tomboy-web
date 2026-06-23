import { describe, it, expect, beforeEach } from 'vitest';
import { musicPlayer, __resetMusicPlayer } from '$lib/music/musicPlayer.svelte.js';
import { __resetMusicProgress } from '$lib/music/musicProgress.js';

const tracks = [{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 }];

const Q = [
	{ url: 'https://x/a.mp3', title: 'A', display: 'A', liPos: 0 },
	{ url: 'https://x/b.mp3', title: 'B', display: 'B', liPos: 0 }
];

let events: string[] = [];

beforeEach(() => {
	__resetMusicPlayer();
	__resetMusicProgress();
	events = [];
	musicPlayer.onTransport((k) => events.push(k));
});

describe('musicPlayer transport emitter', () => {
	it('emits play/pause/stop and stop fires before state clears', () => {
		const seen: Array<{ kind: string; hadTrack: boolean }> = [];
		const off = musicPlayer.onTransport((kind) =>
			seen.push({ kind, hadTrack: !!musicPlayer.currentTrack })
		);

		musicPlayer.playNote('g1', tracks, '음악::x');
		musicPlayer.notifyExplicitPlay();
		musicPlayer.pause();
		musicPlayer.stop();
		off();

		// filter out events from beforeEach listener
		const kindsFromOff = seen.map((s) => s.kind);
		expect(kindsFromOff).toEqual(['play', 'pause', 'stop']);
		expect(seen.find((s) => s.kind === 'stop')!.hadTrack).toBe(true);
		expect(musicPlayer.currentTrack).toBeNull();
	});

	it('unsubscribe stops delivery', () => {
		let n = 0;
		const off = musicPlayer.onTransport(() => n++);
		off();
		musicPlayer.notifyExplicitPlay();
		expect(n).toBe(0);
	});

	it('toggle emits pause on the pause transition only (play recorded elsewhere)', () => {
		const seen: string[] = [];
		const off = musicPlayer.onTransport((k) => seen.push(k));
		musicPlayer.playNote('g1', tracks, '음악::x'); // isPlaying = true, no emit
		musicPlayer.toggle(); // → paused → emit 'pause'
		musicPlayer.toggle(); // → playing → no emit (play recorded via notifyExplicitPlay at gesture layer)
		off();
		expect(seen).toEqual(['pause']);
	});
});

describe('track-change transport', () => {
	it('emits "track" when next() advances while playing', () => {
		musicPlayer.playNote('g', Q, '음악::x'); // sets isPlaying=true (no transport — gesture funnel does that)
		events.length = 0;
		musicPlayer.next();
		expect(events).toEqual(['track']);
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('emits "pause" when next() runs off the end (no wrap)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		musicPlayer.play(1); // last track
		events.length = 0;
		musicPlayer.next(); // no next, repeat=off
		expect(events).toEqual(['pause']);
		expect(musicPlayer.isPlaying).toBe(false);
	});

	it('emits "track" on auto-advance (reportEnded)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		events.length = 0;
		musicPlayer.reportEnded();
		expect(events).toEqual(['track']);
		expect(musicPlayer.currentIndex).toBe(1);
	});

	it('emits "pause" when reportEnded exhausts the queue (no wrap)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		musicPlayer.play(1); // last track
		events.length = 0;
		musicPlayer.reportEnded(); // no next, repeat=off
		expect(events).toEqual(['pause']);
		expect(musicPlayer.isPlaying).toBe(false);
	});

	it('emits nothing on initial playNote (gesture funnel handles play event)', () => {
		// playNote itself calls setQueue + resume, not notifyExplicitPlay
		// events collected in beforeEach listener
		musicPlayer.playNote('g', Q, '음악::x');
		// NO transport emitted by playNote alone
		expect(events).toEqual([]);
	});

	it('emits "track" when prev() moves to a different track', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		musicPlayer.play(1); // advance to track B
		events.length = 0;
		musicPlayer.prev(); // move back to track A
		expect(events).toEqual(['track']);
		expect(musicPlayer.currentIndex).toBe(0);
	});

	it('does NOT emit "track" when prev() is at the first track (seeks to 0 instead)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		// already at index 0
		events.length = 0;
		musicPlayer.prev(); // no previous, seekTo(0)
		expect(events).toEqual([]); // no track event, just a seek
	});

	it('emits nothing on reportEnded with repeat-one (same track restarts)', () => {
		musicPlayer.playNote('g', Q, '음악::x');
		musicPlayer.cycleRepeat(); // off → all
		musicPlayer.cycleRepeat(); // all → one
		events.length = 0;
		musicPlayer.reportEnded(); // repeat-one → requestSeek(0), same track, no emit
		expect(events).toEqual([]);
		expect(musicPlayer.currentIndex).toBe(0);
	});

	it('emits no "track" on a single-track repeat-all wrap (next + reportEnded)', () => {
		musicPlayer.playNote('g', tracks, '음악::x'); // 1-track queue
		musicPlayer.cycleRepeat(); // off → all
		events.length = 0;
		musicPlayer.next(); // wraps to the same index 0 → changed=false → no 'track'
		expect(events).toEqual([]);
		events.length = 0;
		musicPlayer.reportEnded(); // i === currentIndex → requestSeek(0) → no 'track'
		expect(events).toEqual([]);
		expect(musicPlayer.currentIndex).toBe(0);
	});
});
