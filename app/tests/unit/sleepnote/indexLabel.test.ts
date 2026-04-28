import { describe, it, expect } from 'vitest';
import { extractIndexLabelMap } from '$lib/sleepnote/indexLabel.js';

describe('extractIndexLabelMap', () => {
	it('maps each list item HEAD title to the text before its link', () => {
		const xml = `<note-content version="0.1">[0] Slip-Box\n\n이론\n<list><list-item dir="ltr">과학 <link:internal>메타인지</link:internal></list-item></list>\n실용\n<list><list-item dir="ltr">노트 <link:internal>제텔카스텐</link:internal></list-item><list-item dir="ltr">건강 <link:internal>호르몬</link:internal></list-item></list></note-content>`;
		const map = extractIndexLabelMap(xml);
		expect(map.get('메타인지')).toBe('과학');
		expect(map.get('제텔카스텐')).toBe('노트');
		expect(map.get('호르몬')).toBe('건강');
	});

	it('strips a trailing colon / dash from the label', () => {
		const xml = `<note-content version="0.1"><list><list-item dir="ltr">과학: <link:internal>HEAD</link:internal></list-item></list></note-content>`;
		expect(extractIndexLabelMap(xml).get('HEAD')).toBe('과학');
	});

	it('walks nested lists as their own chains', () => {
		const xml = `<note-content version="0.1"><list><list-item dir="ltr">바깥 <link:internal>OUTER</link:internal>\n<list><list-item dir="ltr">안쪽 <link:internal>INNER</link:internal></list-item></list></list-item></list></note-content>`;
		const map = extractIndexLabelMap(xml);
		expect(map.get('OUTER')).toBe('바깥');
		expect(map.get('INNER')).toBe('안쪽');
	});

	it('returns an empty label when the link is the first inline', () => {
		const xml = `<note-content version="0.1"><list><list-item dir="ltr"><link:internal>BARE</link:internal></list-item></list></note-content>`;
		expect(extractIndexLabelMap(xml).get('BARE')).toBe('');
	});

	it('first occurrence wins on duplicate link targets', () => {
		const xml = `<note-content version="0.1"><list><list-item dir="ltr">먼저 <link:internal>HEAD</link:internal></list-item><list-item dir="ltr">나중 <link:internal>HEAD</link:internal></list-item></list></note-content>`;
		expect(extractIndexLabelMap(xml).get('HEAD')).toBe('먼저');
	});

	it('ignores list items without internal links', () => {
		const xml = `<note-content version="0.1"><list><list-item dir="ltr">텍스트만</list-item><list-item dir="ltr">라벨 <link:internal>WITH</link:internal></list-item></list></note-content>`;
		const map = extractIndexLabelMap(xml);
		expect(map.size).toBe(1);
		expect(map.get('WITH')).toBe('라벨');
	});
});
