import { describe, it, expect } from 'vitest';
import {
	assignAccordion,
	type AccordionBlockKind
} from '$lib/editor/labeledDivider/assignAccordion.js';

const H = 2; // headerCount

/** Build a kinds array: 2 header 'other' + the given post-header kinds. */
function withHeaders(...post: AccordionBlockKind[]): AccordionBlockKind[] {
	return ['other', 'other', ...post];
}

describe('assignAccordion', () => {
	it('divider followed by a list is a list-bearing member', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('divider', 'list'),
			headerCount: H
		});
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({
			index: 2,
			ord: 0,
			group: 0,
			listIndices: [3],
			isListBearing: true
		});
		expect(memberCountByGroup.get(0)).toBe(1);
	});

	it('divider NOT followed by a list is not list-bearing and not counted', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('divider', 'other'),
			headerCount: H
		});
		expect(members[0].isListBearing).toBe(false);
		expect(members[0].listIndices).toEqual([]);
		expect(memberCountByGroup.get(0)).toBeUndefined();
	});

	it('owns the maximal consecutive list run', () => {
		const { members } = assignAccordion({
			kinds: withHeaders('divider', 'list', 'list', 'other'),
			headerCount: H
		});
		expect(members[0].listIndices).toEqual([3, 4]);
	});

	it('a paragraph between divider and list breaks the run', () => {
		const { members } = assignAccordion({
			kinds: withHeaders('divider', 'other', 'list'),
			headerCount: H
		});
		expect(members[0].isListBearing).toBe(false);
	});

	it('--- (hr) splits groups; members on each side differ in group', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders(
				'divider', 'list', // ord0 group0
				'divider', 'list', // ord1 group0
				'hr',
				'divider', 'list' // ord2 group1
			),
			headerCount: H
		});
		expect(members.map(m => m.ord)).toEqual([0, 1, 2]);
		expect(members.map(m => m.group)).toEqual([0, 0, 1]);
		expect(memberCountByGroup.get(0)).toBe(2);
		expect(memberCountByGroup.get(1)).toBe(1);
	});

	it('ordinals count ALL dividers incl. non-list-bearing', () => {
		const { members } = assignAccordion({
			kinds: withHeaders(
				'divider', 'other', // ord0, no list
				'divider', 'list' // ord1, list
			),
			headerCount: H
		});
		expect(members.map(m => m.ord)).toEqual([0, 1]);
		expect(members[1].isListBearing).toBe(true);
		expect(members[1].listIndices).toEqual([5]);
	});

	it('skips headerCount leading blocks', () => {
		const { members } = assignAccordion({
			kinds: ['divider', 'list'],
			headerCount: 0
		});
		expect(members[0].index).toBe(0);
		expect(members[0].listIndices).toEqual([1]);
	});

	it('no dividers → empty', () => {
		const { members, memberCountByGroup } = assignAccordion({
			kinds: withHeaders('other', 'list'),
			headerCount: H
		});
		expect(members).toEqual([]);
		expect(memberCountByGroup.size).toBe(0);
	});

	it('headerCount larger than kinds.length is clamped to empty', () => {
		const { members } = assignAccordion({
			kinds: ['divider', 'list'],
			headerCount: 99
		});
		expect(members).toEqual([]);
	});

	it('divider inside the header range is excluded', () => {
		const { members } = assignAccordion({
			kinds: ['divider', 'list', 'divider', 'list'],
			headerCount: 2
		});
		expect(members).toHaveLength(1);
		expect(members[0].index).toBe(2);
	});

	it('empty kinds array → empty output', () => {
		const { members, memberCountByGroup } = assignAccordion({ kinds: [] });
		expect(members).toEqual([]);
		expect(memberCountByGroup.size).toBe(0);
	});
});
