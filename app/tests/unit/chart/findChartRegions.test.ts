import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { findChartRegions } from '../../../src/lib/editor/chartBlock/findChartRegions';

function para(text: string): JSONContent {
	return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function li(text: string, nested?: JSONContent): JSONContent {
	const content: JSONContent[] = [para(text)];
	if (nested) content.push(nested);
	return { type: 'listItem', content };
}
function ul(...items: JSONContent[]): JSONContent {
	return { type: 'bulletList', content: items };
}

describe('findChartRegions', () => {
	it('detects header + flattens nested config lines', () => {
		const doc: JSONContent = {
			type: 'doc',
			content: [
				para('[x] Chart:bar 제목'),
				ul(
					li('DATA::데이터'),
					li('범위', ul(li('[ ]last:15, [x]all')))
				)
			]
		};
		const regions = findChartRegions(doc);
		expect(regions).toHaveLength(1);
		expect(regions[0].headerText).toBe('[x] Chart:bar 제목');
		expect(regions[0].checked).toBe(true);
		expect(regions[0].configLines).toEqual(['DATA::데이터', '범위', '[ ]last:15, [x]all']);
		expect(typeof regions[0].checkboxPos).toBe('number');
		expect(typeof regions[0].headerFromPos).toBe('number');
	});

	it('ignores invalid type', () => {
		const doc: JSONContent = { type: 'doc', content: [para('[x]Chart:pie x')] };
		expect(findChartRegions(doc)).toEqual([]);
	});

	it('returns empty when no chart header', () => {
		const doc: JSONContent = { type: 'doc', content: [para('hello')] };
		expect(findChartRegions(doc)).toEqual([]);
	});
});
