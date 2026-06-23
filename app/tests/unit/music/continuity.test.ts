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

	describe('same source note (same playlist) — no picker, newest side wins', () => {
		it('remote when remote acted more recently', () => {
			expect(
				continuityChoice({
					localTrackUrl: 'a',
					remoteTrackUrl: 'b',
					localNoteGuid: 'note-1',
					remoteNoteGuid: 'note-1',
					localUpdatedAt: '2026-01-01T00:00:00.000Z',
					remoteUpdatedAt: '2026-01-02T00:00:00.000Z'
				})
			).toBe('remote');
		});
		it('local when local acted more recently', () => {
			expect(
				continuityChoice({
					localTrackUrl: 'a',
					remoteTrackUrl: 'b',
					localNoteGuid: 'note-1',
					remoteNoteGuid: 'note-1',
					localUpdatedAt: '2026-01-03T00:00:00.000Z',
					remoteUpdatedAt: '2026-01-02T00:00:00.000Z'
				})
			).toBe('local');
		});
		it('remote when local action time is unknown (fresh boot)', () => {
			expect(
				continuityChoice({
					localTrackUrl: 'a',
					remoteTrackUrl: 'b',
					localNoteGuid: 'note-1',
					remoteNoteGuid: 'note-1',
					localUpdatedAt: null,
					remoteUpdatedAt: '2026-01-02T00:00:00.000Z'
				})
			).toBe('remote');
		});
		it('still both when sources DIFFER', () => {
			expect(
				continuityChoice({
					localTrackUrl: 'a',
					remoteTrackUrl: 'b',
					localNoteGuid: 'note-1',
					remoteNoteGuid: 'note-2',
					localUpdatedAt: '2026-01-01T00:00:00.000Z',
					remoteUpdatedAt: '2026-01-02T00:00:00.000Z'
				})
			).toBe('both');
		});
	});
});
