import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { findTableRegions } from '$lib/editor/tableBlock/findTableRegions.js';

function makeEditor(lines: string[]): Editor {
	return new Editor({
		extensions: [Document, Paragraph, Text],
		// Build the doc programmatically so literal tab characters survive
		// (HTML whitespace normalisation would collapse `\t` → ` ` otherwise).
		content: {
			type: 'doc',
			content: lines.map((line) =>
				line.length === 0
					? { type: 'paragraph' }
					: { type: 'paragraph', content: [{ type: 'text', text: line }] }
			)
		}
	});
}

function paras(...lines: string[]): string[] {
	return lines;
}

describe('findTableRegions', () => {
	it('returns no regions for plain text', () => {
		const ed = makeEditor(paras('hello', 'world'));
		expect(findTableRegions(ed.state.doc)).toEqual([]);
	});

	it('detects a single csv region', () => {
		const ed = makeEditor(
			paras('intro', '```csv', '이름, 내용', '1, 표내용1', '2, 표내용2', '```', 'after')
		);
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].format).toBe('csv');
		expect(regions[0].rows).toEqual([
			['이름', '내용'],
			['1', '표내용1'],
			['2', '표내용2']
		]);
		expect(regions[0].openParaIdx).toBe(1);
		expect(regions[0].closeParaIdx).toBe(5);
	});

	it('detects a tsv region', () => {
		const ed = makeEditor(paras('```tsv', 'a\tb', '```'));
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].format).toBe('tsv');
		expect(regions[0].rows).toEqual([['a', 'b']]);
	});

	it('detects multiple regions in one doc', () => {
		const ed = makeEditor(
			paras('```csv', 'a, b', '```', 'middle', '```tsv', 'x\ty', '```')
		);
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(2);
		expect(regions[0].format).toBe('csv');
		expect(regions[1].format).toBe('tsv');
	});

	it('ignores an unterminated fence (no closing ```)', () => {
		const ed = makeEditor(paras('```csv', 'a, b', 'c, d'));
		expect(findTableRegions(ed.state.doc)).toEqual([]);
	});

	it('handles an empty body (open immediately followed by close)', () => {
		const ed = makeEditor(paras('```csv', '```'));
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].rows).toEqual([]);
	});

	it('returns absolute doc positions for the open and close paragraphs', () => {
		const ed = makeEditor(paras('intro', '```csv', 'a, b', '```'));
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);

		// Verify that openFromPos points at the start of the opening fence
		// paragraph and closeToPos points just after the closing fence
		// paragraph — the plugin uses these to span its hide-decoration.
		const r = regions[0];
		expect(r.openFromPos).toBeGreaterThan(0);
		expect(r.closeToPos).toBeGreaterThan(r.openFromPos);

		// The text between openFromPos and closeToPos should include the
		// fence text on both ends.
		const slice = ed.state.doc.textBetween(r.openFromPos, r.closeToPos, '\n');
		expect(slice).toContain('```csv');
		expect(slice).toContain('a, b');
		expect(slice).toContain('```');
	});

	it('does not match a fence with extra content on the line', () => {
		const ed = makeEditor(paras('```csv extra', 'a, b', '```'));
		expect(findTableRegions(ed.state.doc)).toEqual([]);
	});

	it('skips an inner fence that is itself unterminated then matches the outer pair', () => {
		// "```csv" at idx 0; we look for the next closing fence; that's idx 2.
		// The body is just one line "a, b" — the inner unmatched "```tsv" is
		// inside *no* region because the first close consumes the first open.
		const ed = makeEditor(paras('```csv', 'a, b', '```', '```tsv', 'x\ty'));
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].format).toBe('csv');
	});

	it('does not absorb a later table when the first one lacks a close', () => {
		// Two ```csv opens with NO closing fence between them. The first open
		// is unterminated — its scan must abort when it sees the next opening
		// fence so the second open's body / close don't get merged into the
		// first region. Otherwise multiple tables in one note can mix.
		const ed = makeEditor(
			paras('```csv', 'a, b', '```csv', 'c, d', '```')
		);
		const regions = findTableRegions(ed.state.doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].rows).toEqual([['c', 'd']]);
	});

	it('treats two adjacent opens as both unterminated when no close follows', () => {
		const ed = makeEditor(paras('```csv', '```tsv', 'a\tb'));
		expect(findTableRegions(ed.state.doc)).toEqual([]);
	});
});
