import { describe, it, expect } from 'vitest';
import { parseKeysNote } from '$lib/editor/keyRemote/parseKeysNote.js';
import type { JSONContent } from '@tiptap/core';

function doc(...lines: (string | null)[]): JSONContent {
	return {
		type: 'doc',
		content: lines.map((l) =>
			l === null ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: l }] }
		)
	};
}

describe('parseKeysNote', () => {
	it('matches keys://phone', () => {
		expect(parseKeysNote(doc('제목', 'keys://phone'))).toEqual({
			raw: 'keys://phone',
			host: 'phone',
			user: undefined,
			port: undefined,
			sshTarget: 'ssh://phone'
		});
	});

	it('matches keys://user@host:port', () => {
		expect(parseKeysNote(doc('t', 'keys://u0_a186@localhost:18022'))).toMatchObject({
			user: 'u0_a186',
			host: 'localhost',
			port: 18022,
			sshTarget: 'ssh://u0_a186@localhost:18022'
		});
	});

	it('skips empty lines after title', () => {
		expect(parseKeysNote(doc('t', '', 'keys://phone'))).toMatchObject({ host: 'phone' });
	});

	it('rejects out-of-range port', () => {
		expect(parseKeysNote(doc('t', 'keys://phone:99999'))).toBeNull();
	});

	it('returns null for ssh:// note', () => {
		expect(parseKeysNote(doc('t', 'ssh://phone'))).toBeNull();
	});

	it('returns null for plain note', () => {
		expect(parseKeysNote(doc('t', 'hello world'))).toBeNull();
	});

	it('returns null when no body line', () => {
		expect(parseKeysNote(doc('only-title'))).toBeNull();
	});
});
