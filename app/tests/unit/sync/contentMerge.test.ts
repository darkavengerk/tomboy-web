import { describe, it, expect } from 'vitest';
import { mergeNoteContent } from '$lib/sync/contentMerge.js';

// Helper — wrap body lines in a note-content envelope that mirrors
// what noteArchiver produces. The title lives on the first line along
// with the opening tag; the last line holds the closing tag.
function wrap(title: string, body: string[]): string {
	return `<note-content version="0.1">${title}\n${body.join('\n')}\n</note-content>`;
}

describe('mergeNoteContent', () => {
	describe('fast paths', () => {
		it('returns local when local === remote', () => {
			const res = mergeNoteContent('a', 'b', 'b');
			expect(res).toEqual({ clean: true, merged: 'b' });
		});

		it('returns remote when local was unchanged from base', () => {
			const base = wrap('T', ['one', 'two']);
			const remote = wrap('T', ['one', 'two', 'three']);
			const res = mergeNoteContent(base, base, remote);
			expect(res.clean).toBe(true);
			if (res.clean) expect(res.merged).toBe(remote);
		});

		it('returns local when remote was unchanged from base', () => {
			const base = wrap('T', ['one', 'two']);
			const local = wrap('T', ['zero', 'one', 'two']);
			const res = mergeNoteContent(base, local, base);
			expect(res.clean).toBe(true);
			if (res.clean) expect(res.merged).toBe(local);
		});
	});

	describe('non-overlapping edits', () => {
		it('merges a local prepend and a remote append', () => {
			const base = wrap('T', ['A', 'B', 'C']);
			const local = wrap('T', ['NEWLOCAL', 'A', 'B', 'C']);
			const remote = wrap('T', ['A', 'B', 'C', 'NEWREMOTE']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(true);
			if (res.clean) {
				expect(res.merged).toBe(wrap('T', ['NEWLOCAL', 'A', 'B', 'C', 'NEWREMOTE']));
			}
		});

		it('merges edits in disjoint regions of the body', () => {
			const base = wrap('T', ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
			const local = wrap('T', ['ALPHA', 'beta', 'gamma', 'delta', 'epsilon']);
			const remote = wrap('T', ['alpha', 'beta', 'gamma', 'delta', 'EPSILON']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(true);
			if (res.clean) {
				expect(res.merged).toBe(wrap('T', ['ALPHA', 'beta', 'gamma', 'delta', 'EPSILON']));
			}
		});

		it('merges edits on adjacent lines without a common anchor between them', () => {
			// Regression: early anchor-based algorithm flagged this as a
			// conflict because there was no stable base line between the two
			// edits. Hunk-based diff3 handles it cleanly.
			const base = wrap('T', ['alpha', 'beta']);
			const local = wrap('T', ['ALPHA', 'beta']);
			const remote = wrap('T', ['alpha', 'BETA']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(true);
			if (res.clean) expect(res.merged).toBe(wrap('T', ['ALPHA', 'BETA']));
		});

		it('keeps a line that both sides deleted', () => {
			const base = wrap('T', ['keep', 'drop', 'keep2']);
			const local = wrap('T', ['keep', 'keep2']);
			const remote = wrap('T', ['keep', 'keep2']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(true);
			if (res.clean) expect(res.merged).toBe(wrap('T', ['keep', 'keep2']));
		});
	});

	describe('conflicts', () => {
		it('reports conflict when both sides change the same line differently', () => {
			const base = wrap('T', ['alpha', 'beta', 'gamma']);
			const local = wrap('T', ['alpha', 'BETA-LOCAL', 'gamma']);
			const remote = wrap('T', ['alpha', 'BETA-REMOTE', 'gamma']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(false);
			if (!res.clean) expect(res.reason).toBe('conflict');
		});

		it('reports conflict when both sides add different content in the same gap', () => {
			const base = wrap('T', ['alpha', 'omega']);
			const local = wrap('T', ['alpha', 'LOCAL-BODY', 'omega']);
			const remote = wrap('T', ['alpha', 'REMOTE-BODY', 'omega']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(false);
		});
	});

	describe('title safety', () => {
		it('declines to merge when local renamed the title', () => {
			const base = wrap('Old', ['body']);
			const local = wrap('New', ['body']);
			const remote = wrap('Old', ['body', 'extra']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(false);
			if (!res.clean) expect(res.reason).toBe('title-changed');
		});

		it('declines to merge when remote renamed the title', () => {
			const base = wrap('Old', ['body']);
			const local = wrap('Old', ['body', 'extra']);
			const remote = wrap('New', ['body']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(false);
			if (!res.clean) expect(res.reason).toBe('title-changed');
		});
	});

	describe('both sides made the same change', () => {
		it('treats identical independent edits as non-conflicting', () => {
			const base = wrap('T', ['alpha', 'beta', 'gamma']);
			const local = wrap('T', ['alpha', 'BETA', 'gamma']);
			const remote = wrap('T', ['alpha', 'BETA', 'gamma']);
			const res = mergeNoteContent(base, local, remote);
			expect(res.clean).toBe(true);
			if (res.clean) expect(res.merged).toBe(local);
		});
	});
});
