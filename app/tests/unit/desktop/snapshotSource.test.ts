import { describe, it, expect, beforeEach } from 'vitest';
import { registerSnapshotSource, desktopSession } from '$lib/desktop/session.svelte.js';

beforeEach(() => {
	desktopSession._reset();
});

describe('snapshot source registry', () => {
	it('registers, resolves, and unregisters a source', () => {
		const el = document.createElement('div');
		const off = registerSnapshotSource('g1', () => ({ title: 'T', el }));
		expect(desktopSession.getSnapshotSource('g1')).toEqual({ title: 'T', el });
		off();
		expect(desktopSession.getSnapshotSource('g1')).toBeNull();
	});

	it('returns null for an unknown guid', () => {
		expect(desktopSession.getSnapshotSource('nope')).toBeNull();
	});
});
