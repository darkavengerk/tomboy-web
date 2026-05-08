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
			bridge: undefined,
			history: []
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

function docWithHistory(
	title: string,
	ssh: string,
	bridge: string | null,
	historyItems: string[]
): JSONContent {
	const content: JSONContent[] = [
		{ type: 'paragraph', content: [{ type: 'text', text: title }] },
		{ type: 'paragraph', content: [{ type: 'text', text: ssh }] }
	];
	if (bridge !== null) {
		content.push({ type: 'paragraph', content: [{ type: 'text', text: bridge }] });
	}
	content.push({ type: 'paragraph' });
	content.push({ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] });
	if (historyItems.length > 0) {
		content.push({
			type: 'bulletList',
			content: historyItems.map((t) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
			}))
		});
	}
	return { type: 'doc', content };
}

describe('parseTerminalNote — history', () => {
	it('returns empty history for a plain ssh note', () => {
		const r = parseTerminalNote(doc('Title', 'ssh://localhost'));
		expect(r?.history).toEqual([]);
	});

	it('parses a 3-item history', () => {
		const r = parseTerminalNote(
			docWithHistory('Title', 'ssh://localhost', null, ['ls -la', 'cd /etc', 'tail -f log'])
		);
		expect(r?.host).toBe('localhost');
		expect(r?.history).toEqual(['ls -la', 'cd /etc', 'tail -f log']);
	});

	it('parses history with bridge line', () => {
		const r = parseTerminalNote(
			docWithHistory('Title', 'ssh://localhost', 'bridge: wss://x/ws', ['cmd1'])
		);
		expect(r?.bridge).toBe('wss://x/ws');
		expect(r?.history).toEqual(['cmd1']);
	});

	it('header without bullet list returns empty history', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] }
			]
		});
		expect(r).toMatchObject({ host: 'localhost', history: [] });
	});

	it('drops empty list items', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
						{ type: 'listItem', content: [{ type: 'paragraph' }] },
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }
					]
				}
			]
		});
		expect(r?.history).toEqual(['a', 'b']);
	});

	it('returns null when a free paragraph is after history', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }
					]
				},
				{ type: 'paragraph', content: [{ type: 'text', text: 'extra junk' }] }
			]
		});
		expect(r).toBeNull();
	});

	it('returns null when bullet list appears without header', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'bulletList', content: [] }
			]
		});
		expect(r).toBeNull();
	});

	it('marks ignored — italic in list item still extracts plain text', () => {
		const r = parseTerminalNote({
			type: 'doc',
			content: [
				{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'ssh://localhost' }] },
				{ type: 'paragraph', content: [{ type: 'text', text: 'history:' }] },
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'text', text: 'sudo ' },
										{ type: 'text', marks: [{ type: 'italic' }], text: 'systemctl' },
										{ type: 'text', text: ' restart caddy' }
									]
								}
							]
						}
					]
				}
			]
		});
		expect(r?.history).toEqual(['sudo systemctl restart caddy']);
	});
});
