import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';

// Mock the titleProvider module so checkTitleConflict uses a controllable
// lookup. The guard module imports `lookupGuidByTitle` from this path.
const lookupGuidByTitleMock = vi.fn<(title: string) => string | null>();
const ensureTitleIndexReadyMock = vi.fn(async () => {});

vi.mock('$lib/editor/autoLink/titleProvider.js', () => ({
	lookupGuidByTitle: (title: string) => lookupGuidByTitleMock(title),
	ensureTitleIndexReady: () => ensureTitleIndexReadyMock()
}));

import {
	checkTitleConflict,
	isCursorInTitleBlock,
	titleEndPos,
	extractTitleText
} from '$lib/editor/titleUniqueGuard.js';

beforeEach(() => {
	lookupGuidByTitleMock.mockReset();
	ensureTitleIndexReadyMock.mockClear();
});

describe('checkTitleConflict', () => {
	it('returns no conflict for an empty title', () => {
		lookupGuidByTitleMock.mockReturnValue('other');
		const out = checkTitleConflict('', 'me');
		expect(out).toEqual({ conflict: false, existingGuid: null });
		expect(lookupGuidByTitleMock).not.toHaveBeenCalled();
	});

	it('returns no conflict for a whitespace-only title', () => {
		lookupGuidByTitleMock.mockReturnValue('other');
		const out = checkTitleConflict('   \t  ', 'me');
		expect(out).toEqual({ conflict: false, existingGuid: null });
		expect(lookupGuidByTitleMock).not.toHaveBeenCalled();
	});

	it('returns no conflict when lookupGuidByTitle returns null', () => {
		lookupGuidByTitleMock.mockReturnValue(null);
		const out = checkTitleConflict('Foo', 'me');
		expect(out).toEqual({ conflict: false, existingGuid: null });
	});

	it('returns no conflict when the hit equals selfGuid', () => {
		lookupGuidByTitleMock.mockReturnValue('me');
		const out = checkTitleConflict('Foo', 'me');
		expect(out).toEqual({ conflict: false, existingGuid: null });
	});

	it('flags conflict when the hit is another guid', () => {
		lookupGuidByTitleMock.mockReturnValue('other-guid');
		const out = checkTitleConflict('Foo', 'me');
		expect(out).toEqual({ conflict: true, existingGuid: 'other-guid' });
	});

	it('flags conflict when selfGuid is null and a hit exists', () => {
		lookupGuidByTitleMock.mockReturnValue('some-guid');
		const out = checkTitleConflict('Foo', null);
		expect(out).toEqual({ conflict: true, existingGuid: 'some-guid' });
	});

	it('is case-sensitive — differing-case input does not match a differently-cased entry', () => {
		// Map only has 'Foo' → 'other'. Lookup for 'foo' should return null from
		// the real implementation; we assert checkTitleConflict honours that.
		const map = new Map<string, string>([['Foo', 'other']]);
		lookupGuidByTitleMock.mockImplementation((t: string) => map.get(t) ?? null);
		const out = checkTitleConflict('foo', null);
		expect(out).toEqual({ conflict: false, existingGuid: null });
	});

	it('trims the input before looking up', () => {
		lookupGuidByTitleMock.mockImplementation((t: string) =>
			t === 'Foo' ? 'other' : null
		);
		const out = checkTitleConflict('   Foo\n  ', null);
		expect(out).toEqual({ conflict: true, existingGuid: 'other' });
		expect(lookupGuidByTitleMock).toHaveBeenCalledWith('Foo');
	});
});

function makeMinimalEditor(contentJson: unknown): Editor {
	return new Editor({
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				paragraph: false,
				listItem: false
			}),
			TomboyParagraph,
			TomboyListItem
		],
		content: contentJson as never
	});
}

describe('isCursorInTitleBlock', () => {
	it('returns true for a position inside the first paragraph', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		try {
			// Position 2 is inside the first paragraph (between T and i).
			expect(isCursorInTitleBlock(editor.state.doc, 2)).toBe(true);
			// Position 1 is also inside the first paragraph (start of text).
			expect(isCursorInTitleBlock(editor.state.doc, 1)).toBe(true);
		} finally {
			editor.destroy();
		}
	});

	it('returns false for a position in a later block', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		try {
			// First paragraph: nodeSize = 5 (text) + 2 (open/close) = 7. So
			// positions 8..11 are inside the second paragraph.
			const lastPos = editor.state.doc.content.size; // inside second para
			expect(isCursorInTitleBlock(editor.state.doc, lastPos)).toBe(false);
		} finally {
			editor.destroy();
		}
	});

	it('returns false (does not throw) for out-of-range positions', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }
			]
		});
		try {
			expect(() => isCursorInTitleBlock(editor.state.doc, -1)).not.toThrow();
			expect(isCursorInTitleBlock(editor.state.doc, -1)).toBe(false);
			expect(() =>
				isCursorInTitleBlock(editor.state.doc, 999_999)
			).not.toThrow();
			expect(isCursorInTitleBlock(editor.state.doc, 999_999)).toBe(false);
		} finally {
			editor.destroy();
		}
	});
});

describe('titleEndPos', () => {
	it('returns nodeSize-1 for a non-empty first paragraph', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Foo' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		try {
			// "Foo" text (length 3) + open + close = nodeSize 5; end = 4.
			expect(titleEndPos(editor.state.doc)).toBe(4);
		} finally {
			editor.destroy();
		}
	});

	it('returns 1 for a doc with a single empty paragraph', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [{ type: 'paragraph' }]
		});
		try {
			expect(titleEndPos(editor.state.doc)).toBe(1);
		} finally {
			editor.destroy();
		}
	});
});

describe('extractTitleText', () => {
	it('returns the first paragraph textContent', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Hello World' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
			]
		});
		try {
			expect(extractTitleText(editor.state.doc)).toBe('Hello World');
		} finally {
			editor.destroy();
		}
	});

	it('returns empty string for an empty first block', () => {
		const editor = makeMinimalEditor({
			type: 'doc',
			content: [{ type: 'paragraph' }]
		});
		try {
			expect(extractTitleText(editor.state.doc)).toBe('');
		} finally {
			editor.destroy();
		}
	});
});
