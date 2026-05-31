import { describe, it, expect } from 'vitest';
import { rewriteSpectateLine } from '$lib/editor/terminal/parseTerminalNote.js';

/**
 * The XML format mirrors what TipTap's `<note-content>` produces — paragraphs
 * are typically separated by newlines or wrapped in <p>...</p> depending on
 * the serializer. We test against the actual shape used by Tomboy notes:
 * each paragraph is a sequence of text/marked text inside <note-content>,
 * with paragraph boundaries being newlines in the raw XML.
 */

describe('rewriteSpectateLine', () => {
	it('adds :N when none was present', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 3);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>'
		);
	});

	it('removes :N when n is null', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', null);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main\nbody</note-content>'
		);
	});

	it('replaces :N with a different :M', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main:3\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 5);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:5\nbody</note-content>'
		);
	});

	it('returns input unchanged when no spectate: line is present', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nbridge: wss://b/ws</note-content>';
		expect(rewriteSpectateLine(xml, 'main', 3)).toBe(xml);
	});

	it('preserves colons inside session names (grp:web:2 → grp:web:5)', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: grp:web:2\nbody</note-content>';
		const out = rewriteSpectateLine(xml, 'grp:web', 5);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: grp:web:5\nbody</note-content>'
		);
	});

	it('only replaces the first spectate: line if multiple exist', () => {
		const xml = '<note-content version="0.1">spectate: a\nspectate: b\n</note-content>';
		const out = rewriteSpectateLine(xml, 'a', 4);
		expect(out).toBe('<note-content version="0.1">spectate: a:4\nspectate: b\n</note-content>');
	});

	it('does not touch bridge: or ssh:// lines', () => {
		const xml = '<note-content version="0.1">ssh://host\nbridge: wss://b/ws\nspectate: main</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 2);
		expect(out).toBe(
			'<note-content version="0.1">ssh://host\nbridge: wss://b/ws\nspectate: main:2</note-content>'
		);
	});

	it('handles spectate: line at the very end of content (no trailing newline)', () => {
		const xml = '<note-content version="0.1">Title\nssh://host\nspectate: main</note-content>';
		const out = rewriteSpectateLine(xml, 'main', 1);
		expect(out).toBe(
			'<note-content version="0.1">Title\nssh://host\nspectate: main:1</note-content>'
		);
	});
});
