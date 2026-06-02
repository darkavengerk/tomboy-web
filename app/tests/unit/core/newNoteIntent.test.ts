import { describe, it, expect } from 'vitest';
import {
	setNewNoteIntent,
	consumeNewNoteIntent
} from '$lib/core/newNoteIntent.js';

describe('newNoteIntent', () => {
	it('returns the intent that was set for a guid', () => {
		setNewNoteIntent('guid-a', 'selectTitle');
		expect(consumeNewNoteIntent('guid-a')).toBe('selectTitle');

		setNewNoteIntent('guid-b', 'bodyCursor');
		expect(consumeNewNoteIntent('guid-b')).toBe('bodyCursor');
	});

	it('deletes on read — a second consume returns undefined', () => {
		setNewNoteIntent('guid-c', 'selectTitle');
		expect(consumeNewNoteIntent('guid-c')).toBe('selectTitle');
		expect(consumeNewNoteIntent('guid-c')).toBeUndefined();
	});

	it('returns undefined for a guid that was never set', () => {
		expect(consumeNewNoteIntent('never-set')).toBeUndefined();
	});

	it('keeps intents for different guids independent', () => {
		setNewNoteIntent('g1', 'selectTitle');
		setNewNoteIntent('g2', 'bodyCursor');
		expect(consumeNewNoteIntent('g2')).toBe('bodyCursor');
		// Consuming g2 must not affect g1.
		expect(consumeNewNoteIntent('g1')).toBe('selectTitle');
	});
});
