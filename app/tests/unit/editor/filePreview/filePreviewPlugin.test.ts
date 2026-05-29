import { describe, it, expect, vi } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { findFileUrlRanges } from '$lib/editor/filePreview/filePreviewPlugin.js';
import {
	deserializeContent,
	serializeContent
} from '$lib/core/noteContentArchiver.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: async () => 'wss://b.test/ws',
	bridgeToHttpBase: (_b: string) => 'https://b.test'
}));

const schema = new Schema({
	nodes: {
		doc: { content: 'paragraph+' },
		paragraph: { content: 'text*', toDOM: () => ['p', 0] },
		text: {}
	}
});

function docOf(text: string): PMNode {
	return schema.node('doc', null, [
		schema.node('paragraph', null, [schema.text(text)])
	]);
}

describe('findFileUrlRanges', () => {
	it('finds bridge file URL', () => {
		const url = 'https://b.test/files/11111111-2222-3333-4444-555555555555/doc.pdf';
		const r = findFileUrlRanges(docOf(`see ${url} please`), 'https://b.test');
		expect(r).toHaveLength(1);
		expect(r[0].href).toBe(url);
	});

	it('ignores non-bridge URL on same path shape', () => {
		const url = 'https://other.test/files/11111111-2222-3333-4444-555555555555/doc.pdf';
		const r = findFileUrlRanges(docOf(url), 'https://b.test');
		expect(r).toHaveLength(0);
	});

	it('ignores bridge URL without /files/ prefix', () => {
		const url = 'https://b.test/health';
		const r = findFileUrlRanges(docOf(url), 'https://b.test');
		expect(r).toHaveLength(0);
	});

	it('ignores bridge URL with invalid uuid', () => {
		const url = 'https://b.test/files/not-a-uuid/doc.pdf';
		const r = findFileUrlRanges(docOf(url), 'https://b.test');
		expect(r).toHaveLength(0);
	});

	it('finds multiple URLs in same paragraph', () => {
		const u1 = 'https://b.test/files/11111111-2222-3333-4444-555555555555/a.pdf';
		const u2 = 'https://b.test/files/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/b.zip';
		const r = findFileUrlRanges(docOf(`${u1} and ${u2}`), 'https://b.test');
		expect(r).toHaveLength(2);
		expect(r[0].href).toBe(u1);
		expect(r[1].href).toBe(u2);
	});
});

describe('roundtrip', () => {
	it('bridge URL survives deserialize → serialize byte-identical', () => {
		const url = 'https://b.test/files/11111111-2222-3333-4444-555555555555/doc.pdf';
		// Wrap URL in <link:url> mirror of the tomboyUrlLink mark — same XML
		// shape that incoming Tomboy notes use.
		const incoming = `<note-content version="0.1">prefix <link:url>${url}</link:url> suffix</note-content>`;
		const doc = deserializeContent(incoming);
		const archived = serializeContent(doc);
		expect(archived).toContain(`<link:url>${url}</link:url>`);
	});
});
