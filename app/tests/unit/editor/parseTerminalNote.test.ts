import { describe, it, expect } from 'vitest';
import { parseTerminalNote } from '$lib/editor/terminal/parseTerminalNote.js';
import type { JSONContent } from '@tiptap/core';

function doc(...lines: (string | null)[]): JSONContent {
	const content = lines.map((line) => {
		if (line === null) return { type: 'paragraph' };
		return { type: 'paragraph', content: [{ type: 'text', text: line }] };
	});
	return { type: 'doc', content };
}

describe('parseTerminalNote — match', () => {
	it('matches ssh://host', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://example.com'));
		expect(r).toEqual({
			target: 'ssh://example.com',
			host: 'example.com',
			port: undefined,
			user: undefined,
			bridge: undefined
		});
	});

	it('matches ssh://user@host:port', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://alice@10.0.0.1:2222'));
		expect(r).toMatchObject({ user: 'alice', host: '10.0.0.1', port: 2222 });
	});

	it('matches ssh://localhost', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://localhost'));
		expect(r).toMatchObject({ host: 'localhost' });
	});

	it('matches with bridge line', () => {
		const r = parseTerminalNote(
			doc('Title', 'ssh://localhost', 'bridge: wss://my.duckdns.org/ws')
		);
		expect(r).toMatchObject({ host: 'localhost', bridge: 'wss://my.duckdns.org/ws' });
	});

	it('matches with bridge line using ws:// (left for caller to reject)', () => {
		// The parser doesn't enforce wss; the wsClient layer can reject ws://.
		const r = parseTerminalNote(doc('Title', 'ssh://localhost', 'bridge: ws://insecure'));
		expect(r?.bridge).toBe('ws://insecure');
	});

	it('tolerates a trailing empty paragraph after the metadata', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://localhost', null));
		expect(r).toMatchObject({ host: 'localhost' });
	});

	it('tolerates a leading empty paragraph between title and metadata', () => {
		// Some Tomboy round-trips emit a blank line — we accept it.
		const r = parseTerminalNote(doc('Title', null, 'ssh://localhost'));
		expect(r).toMatchObject({ host: 'localhost' });
	});
});

describe('parseTerminalNote — no match', () => {
	it('returns null for empty doc', () => {
		expect(parseTerminalNote({ type: 'doc', content: [{ type: 'paragraph' }] })).toBeNull();
	});

	it('returns null when title only', () => {
		expect(parseTerminalNote(doc('Title'))).toBeNull();
	});

	it('returns null when first body line is plain text', () => {
		expect(parseTerminalNote(doc('Title', 'just a normal note'))).toBeNull();
	});

	it('returns null when more than 2 body lines', () => {
		const r = parseTerminalNote(
			doc('Title', 'ssh://localhost', 'bridge: wss://x/ws', 'extra stuff')
		);
		expect(r).toBeNull();
	});

	it('returns null when bridge line is malformed', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://localhost', 'bridge: not-a-url'));
		expect(r).toBeNull();
	});

	it('returns null for invalid port', () => {
		expect(parseTerminalNote(doc('Title', 'ssh://host:99999'))).toBeNull();
	});

	it('returns null when scheme is not ssh', () => {
		expect(parseTerminalNote(doc('Title', 'http://host'))).toBeNull();
	});

	it('returns null when body contains a non-paragraph block', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'bulletList', content: [] }
			]
		});
		expect(r).toBeNull();
	});

	it('returns null when ssh line carries a hardBreak (split)', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'ssh://' },
						{ type: 'hardBreak' },
						{ type: 'text', text: 'localhost' }
					]
				}
			]
		});
		expect(r).toBeNull();
	});
});
