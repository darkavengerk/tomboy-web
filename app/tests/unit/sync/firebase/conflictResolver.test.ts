import { describe, it, expect } from 'vitest';
import {
	resolveNoteConflict,
	type ConflictSide
} from '$lib/sync/firebase/conflictResolver.js';

const T_OLD = '2026-04-26T10:00:00.0000000+09:00';
const T_MID = '2026-04-27T10:00:00.0000000+09:00';
const T_NEW = '2026-04-28T10:00:00.0000000+09:00';

function side(overrides: Partial<ConflictSide> = {}): ConflictSide {
	return {
		xmlContent: '<note-content version="0.1">제목\n\n본문</note-content>',
		changeDate: T_MID,
		metadataChangeDate: T_MID,
		tags: [],
		deleted: false,
		...overrides
	};
}

describe('resolveNoteConflict', () => {
	it('both missing → noop', () => {
		expect(resolveNoteConflict(undefined, undefined)).toEqual({ kind: 'noop' });
	});

	it('only local exists → push (remote-missing)', () => {
		expect(resolveNoteConflict(side(), undefined)).toEqual({
			kind: 'push',
			reason: 'remote-missing'
		});
	});

	it('only remote exists → pull (local-missing)', () => {
		expect(resolveNoteConflict(undefined, side())).toEqual({
			kind: 'pull',
			reason: 'local-missing'
		});
	});

	it('identical content/tags/deleted → noop', () => {
		const a = side({ tags: ['x', 'y'] });
		const b = side({ tags: ['x', 'y'] });
		expect(resolveNoteConflict(a, b)).toEqual({ kind: 'noop' });
	});

	it('local has newer changeDate → push (local-newer)', () => {
		const local = side({ xmlContent: 'A', changeDate: T_NEW });
		const remote = side({ xmlContent: 'B', changeDate: T_MID });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'push',
			reason: 'local-newer'
		});
	});

	it('remote has newer changeDate → pull (remote-newer)', () => {
		const local = side({ xmlContent: 'A', changeDate: T_MID });
		const remote = side({ xmlContent: 'B', changeDate: T_NEW });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'pull',
			reason: 'remote-newer'
		});
	});

	it('equal changeDate but local metadataChangeDate is newer → push', () => {
		const local = side({
			tags: ['a'],
			changeDate: T_MID,
			metadataChangeDate: T_NEW
		});
		const remote = side({
			tags: [],
			changeDate: T_MID,
			metadataChangeDate: T_MID
		});
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'push',
			reason: 'local-newer'
		});
	});

	it('equal changeDate but remote metadataChangeDate is newer → pull', () => {
		const local = side({
			tags: [],
			changeDate: T_MID,
			metadataChangeDate: T_MID
		});
		const remote = side({
			tags: ['b'],
			changeDate: T_MID,
			metadataChangeDate: T_NEW
		});
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'pull',
			reason: 'remote-newer'
		});
	});

	it('all timestamps equal but content differs → push (prefer local)', () => {
		const local = side({ xmlContent: 'A' });
		const remote = side({ xmlContent: 'B' });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'push',
			reason: 'tie-prefers-local'
		});
	});

	it('remote tombstone newer than local → pull (remote-newer, tombstone)', () => {
		const local = side({ changeDate: T_OLD });
		const remote = side({ changeDate: T_NEW, deleted: true });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'pull',
			reason: 'remote-newer'
		});
	});

	it('local resurrection (newer than remote tombstone) → push (local-newer)', () => {
		const local = side({ changeDate: T_NEW, deleted: false });
		const remote = side({ changeDate: T_MID, deleted: true });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'push',
			reason: 'local-newer'
		});
	});

	it('both deleted with same timestamps → noop', () => {
		const local = side({ deleted: true });
		const remote = side({ deleted: true });
		expect(resolveNoteConflict(local, remote)).toEqual({ kind: 'noop' });
	});

	it('tag-only difference at the same timestamps → push (prefer local)', () => {
		const local = side({ tags: ['x'] });
		const remote = side({ tags: ['y'] });
		expect(resolveNoteConflict(local, remote)).toEqual({
			kind: 'push',
			reason: 'tie-prefers-local'
		});
	});

	it('treats string ISO comparison correctly across days', () => {
		const local = side({
			xmlContent: 'A',
			changeDate: '2026-12-31T23:59:59.0000000+09:00'
		});
		const remote = side({
			xmlContent: 'B',
			changeDate: '2027-01-01T00:00:01.0000000+09:00'
		});
		expect(resolveNoteConflict(local, remote).kind).toBe('pull');
	});

	describe('mixed timezone offsets (bridge writes +00:00, app writes +09:00)', () => {
		it('remote absolutely newer wins even when local string sorts higher (production repro)', () => {
			// local: 01:09 KST = 2026-07-16T16:09Z (older). remote: 01:05 UTC (newer).
			// localeCompare would say local > remote and push the stale doc.
			const local = side({
				xmlContent: 'stale phone doc',
				changeDate: '2026-07-17T01:09:40.0330000+09:00'
			});
			const remote = side({
				xmlContent: 'fresh bridge write',
				changeDate: '2026-07-17T01:05:58.5150000+00:00'
			});
			expect(resolveNoteConflict(local, remote)).toEqual({
				kind: 'pull',
				reason: 'remote-newer'
			});
		});

		it('local absolutely newer wins even when remote string sorts higher', () => {
			const local = side({
				xmlContent: 'fresh local',
				changeDate: '2026-07-17T01:05:58.0000000+00:00'
			});
			const remote = side({
				xmlContent: 'stale remote',
				changeDate: '2026-07-17T01:09:40.0000000+09:00'
			});
			expect(resolveNoteConflict(local, remote)).toEqual({
				kind: 'push',
				reason: 'local-newer'
			});
		});

		it('metadataChangeDate tiebreak also compares by absolute instant', () => {
			const shared = '2026-07-17T01:00:00.0000000+00:00';
			const local = side({
				xmlContent: 'A',
				changeDate: shared,
				metadataChangeDate: '2026-07-17T01:09:40.0000000+09:00' // 16:09Z 전날 = older
			});
			const remote = side({
				xmlContent: 'B',
				changeDate: shared,
				metadataChangeDate: '2026-07-17T01:05:58.0000000+00:00' // newer instant
			});
			expect(resolveNoteConflict(local, remote)).toEqual({
				kind: 'pull',
				reason: 'remote-newer'
			});
		});

		it('unparseable date falls back to string comparison', () => {
			const local = side({ xmlContent: 'A', changeDate: 'not-a-date-b' });
			const remote = side({ xmlContent: 'B', changeDate: 'not-a-date-a' });
			expect(resolveNoteConflict(local, remote)).toEqual({
				kind: 'push',
				reason: 'local-newer'
			});
		});
	});
});
