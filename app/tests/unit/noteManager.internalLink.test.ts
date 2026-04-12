import { describe, it, expect } from 'vitest';
import * as mod from '$lib/core/noteManager.js';

describe('noteManager internal link', () => {
	it('findNoteByTitle is exported', () => {
		expect(mod).toHaveProperty('findNoteByTitle');
		expect(typeof mod.findNoteByTitle).toBe('function');
	});

	it('resolveOrCreateNoteByTitle is no longer exported', () => {
		expect(mod).not.toHaveProperty('resolveOrCreateNoteByTitle');
	});
});
