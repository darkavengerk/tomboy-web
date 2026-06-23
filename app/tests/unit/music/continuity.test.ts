import { describe, it, expect } from 'vitest';
import { continuityChoice } from '$lib/music/continuity.js';

describe('continuityChoice', () => {
	it('none when neither side has a track', () => {
		expect(continuityChoice({ localTrackUrl: null, remoteTrackUrl: null })).toBe('none');
	});
	it('local when only local', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: null })).toBe('local');
	});
	it('remote when only remote', () => {
		expect(continuityChoice({ localTrackUrl: null, remoteTrackUrl: 'b' })).toBe('remote');
	});
	it('both when present and different', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: 'b' })).toBe('both');
	});
	it('local when same track (no picker)', () => {
		expect(continuityChoice({ localTrackUrl: 'a', remoteTrackUrl: 'a' })).toBe('local');
	});
});
