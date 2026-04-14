import { describe, it, expect } from 'vitest';
import { buildGraph } from '$lib/graph/buildGraph.js';
import type { NoteData } from '$lib/core/note.js';

function makeNote(
	guid: string,
	title: string,
	internalLinks: string[] = [],
	changeDate = '2024-01-01T00:00:00.0000000+00:00',
	tags: string[] = []
): NoteData {
	const body = internalLinks
		.map((t) => `<link:internal>${t}</link:internal>`)
		.join(' ');
	const xmlContent = `<note-content version="0.1">${title}\n\n${body}</note-content>`;
	return {
		uri: `note://tomboy/${guid}`,
		guid,
		title,
		xmlContent,
		createDate: changeDate,
		changeDate,
		metadataChangeDate: changeDate,
		cursorPosition: 0,
		selectionBoundPosition: -1,
		width: 450,
		height: 360,
		x: 0,
		y: 0,
		tags,
		openOnStartup: false,
		localDirty: false,
		deleted: false
	};
}

describe('buildGraph', () => {
	it('returns empty nodes/links for empty input', () => {
		const g = buildGraph([]);
		expect(g.nodes).toEqual([]);
		expect(g.links).toEqual([]);
	});

	it('produces one node per input note with no links for isolated notes', () => {
		const g = buildGraph([makeNote('a', 'Alpha'), makeNote('b', 'Beta')]);
		expect(g.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
		expect(g.links).toEqual([]);
		expect(g.nodes.every((n) => n.size === 1)).toBe(true);
	});

	it('resolves internal links by title (case-insensitive) → guid', () => {
		const notes = [
			makeNote('a', 'Alpha', ['Beta']),
			makeNote('b', 'Beta')
		];
		const g = buildGraph(notes);
		expect(g.links).toHaveLength(1);
		expect(g.links[0]).toEqual({ source: 'a', target: 'b' });
	});

	it('drops broken-target links (missing target title)', () => {
		const notes = [makeNote('a', 'Alpha', ['NoSuchNote'])];
		const g = buildGraph(notes);
		expect(g.links).toEqual([]);
	});

	it('drops self-links', () => {
		const notes = [makeNote('a', 'Alpha', ['Alpha'])];
		const g = buildGraph(notes);
		expect(g.links).toEqual([]);
	});

	it('deduplicates repeated (source, target) edges', () => {
		const notes = [
			makeNote('a', 'Alpha', ['Beta', 'Beta', 'beta']),
			makeNote('b', 'Beta')
		];
		const g = buildGraph(notes);
		expect(g.links).toHaveLength(1);
	});

	it('resolves title collisions to the most recently changed note', () => {
		const notes = [
			makeNote('dup-old', 'Shared', [], '2023-01-01T00:00:00.0000000+00:00'),
			makeNote('dup-new', 'Shared', [], '2025-01-01T00:00:00.0000000+00:00'),
			makeNote('src', 'Source', ['Shared'])
		];
		const g = buildGraph(notes);
		expect(g.links).toEqual([{ source: 'src', target: 'dup-new' }]);
	});

	it('flags home and sleep nodes', () => {
		const g = buildGraph([makeNote('h', 'Home'), makeNote('s', 'Sleep'), makeNote('n', 'Normal')], {
			homeGuid: 'h',
			sleepGuid: 's'
		});
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		expect(byId.get('h')!.isHome).toBe(true);
		expect(byId.get('h')!.isSleep).toBe(false);
		expect(byId.get('s')!.isSleep).toBe(true);
		expect(byId.get('n')!.isHome).toBe(false);
		expect(byId.get('n')!.isSleep).toBe(false);
	});

	it('scales node size logarithmically with degree, capped at 2.0', () => {
		// Build a hub: "Hub" is linked to by 4 notes, and has 0 outgoing.
		// Also an isolated "Solo" note.
		const notes = [
			makeNote('hub', 'Hub'),
			makeNote('a', 'A', ['Hub']),
			makeNote('b', 'B', ['Hub']),
			makeNote('c', 'C', ['Hub']),
			makeNote('d', 'D', ['Hub']),
			makeNote('solo', 'Solo')
		];
		const g = buildGraph(notes);
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		const hub = byId.get('hub')!;
		const solo = byId.get('solo')!;
		const a = byId.get('a')!;

		// Solo has degree 0 → size 1.
		expect(solo.degree).toBe(0);
		expect(solo.size).toBe(1);

		// Hub has the max degree (4) → size should be exactly 2.
		expect(hub.degree).toBe(4);
		expect(hub.size).toBeCloseTo(2, 10);

		// A single-link note is between 1 and 2, closer to 1.
		expect(a.degree).toBe(1);
		expect(a.size).toBeGreaterThan(1);
		expect(a.size).toBeLessThan(2);

		// All sizes capped within [1, 2].
		for (const n of g.nodes) {
			expect(n.size).toBeGreaterThanOrEqual(1);
			expect(n.size).toBeLessThanOrEqual(2);
		}
	});

	describe('includeCategories', () => {
		it('adds no extra nodes when the option is off', () => {
			const notes = [
				makeNote('a', 'A', [], undefined, ['system:notebook:Work']),
				makeNote('b', 'B', [], undefined, ['system:notebook:Work'])
			];
			const g = buildGraph(notes);
			expect(g.nodes).toHaveLength(2);
			expect(g.nodes.some((n) => n.isCategory)).toBe(false);
		});

		it('adds a category node per notebook with edges from member notes', () => {
			const notes = [
				makeNote('a', 'A', [], undefined, ['system:notebook:Work']),
				makeNote('b', 'B', [], undefined, ['system:notebook:Work']),
				makeNote('c', 'C', [], undefined, ['system:notebook:Home']),
				makeNote('d', 'D', [], undefined, []) // no notebook
			];
			const g = buildGraph(notes, { includeCategories: true });
			const cats = g.nodes.filter((n) => n.isCategory);
			expect(cats.map((c) => c.title).sort()).toEqual(['Home', 'Work']);
			expect(cats.every((c) => c.id.startsWith('category:'))).toBe(true);

			const categoryEdges = g.links.filter((l) =>
				l.target.startsWith('category:')
			);
			expect(categoryEdges).toHaveLength(3);
			expect(
				categoryEdges.find((l) => l.source === 'a')?.target
			).toBe('category:Work');
			expect(
				categoryEdges.find((l) => l.source === 'c')?.target
			).toBe('category:Home');
		});

		it('scales category size with its member count (log)', () => {
			// Work has 4 members, Home has 1.
			const notes = [
				makeNote('a', 'A', [], undefined, ['system:notebook:Work']),
				makeNote('b', 'B', [], undefined, ['system:notebook:Work']),
				makeNote('c', 'C', [], undefined, ['system:notebook:Work']),
				makeNote('d', 'D', [], undefined, ['system:notebook:Work']),
				makeNote('e', 'E', [], undefined, ['system:notebook:Home'])
			];
			const g = buildGraph(notes, { includeCategories: true });
			const work = g.nodes.find((n) => n.id === 'category:Work')!;
			const home = g.nodes.find((n) => n.id === 'category:Home')!;
			expect(work.size).toBeCloseTo(2, 10); // max → full size
			expect(home.size).toBeGreaterThan(1);
			expect(home.size).toBeLessThan(2);
		});
	});

	it('invokes onProgress for each note processed', () => {
		const notes = [makeNote('a', 'A'), makeNote('b', 'B'), makeNote('c', 'C')];
		const calls: Array<[number, number]> = [];
		buildGraph(notes, { onProgress: (done, total) => calls.push([done, total]) });
		expect(calls).toEqual([
			[1, 3],
			[2, 3],
			[3, 3]
		]);
	});
});
