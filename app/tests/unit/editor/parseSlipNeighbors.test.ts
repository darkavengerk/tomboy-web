import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { TomboyMonospace } from '$lib/editor/extensions/TomboyMonospace.js';
import { TomboySize } from '$lib/editor/extensions/TomboySize.js';
import { parseSlipNeighbors } from '$lib/editor/extensions/SlipNoteArrows.js';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';

let currentEditor: Editor | null = null;

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

function makeEditor(initialDoc: ReturnType<typeof deserializeContent>): Editor {
	const editor = new Editor({
		extensions: [
			StarterKit.configure({ code: false, codeBlock: false }),
			TomboySize,
			TomboyMonospace,
			TomboyInternalLink.configure({
				getTitles: () => [],
				getCurrentGuid: () => null
			}),
			TomboyUrlLink
		],
		content: initialDoc
	});
	currentEditor = editor;
	return editor;
}

describe('parseSlipNeighbors', () => {
	it('extracts both prev and next link targets', () => {
		const xml =
			'<note-content version="0.1">Note B\n\n' +
			'이전: <link:internal>Note A</link:internal>\n' +
			'다음: <link:internal>Note C</link:internal>\n\n</note-content>';
		const editor = makeEditor(deserializeContent(xml));
		expect(parseSlipNeighbors(editor.state.doc)).toEqual({
			prev: 'Note A',
			next: 'Note C'
		});
	});

	it('returns null targets when prev or next has the "없음" placeholder', () => {
		const xml =
			'<note-content version="0.1">HEAD\n\n' +
			'이전: 없음\n' +
			'다음: <link:internal>Next</link:internal>\n\n</note-content>';
		const editor = makeEditor(deserializeContent(xml));
		const r = parseSlipNeighbors(editor.state.doc);
		expect(r.prev).toBeNull();
		expect(r.next).toBe('Next');
	});

	it('returns nulls for a doc that lacks the slip-note shape', () => {
		const xml = '<note-content version="0.1">Just a title\n\nbody</note-content>';
		const editor = makeEditor(deserializeContent(xml));
		expect(parseSlipNeighbors(editor.state.doc)).toEqual({
			prev: null,
			next: null
		});
	});
});
