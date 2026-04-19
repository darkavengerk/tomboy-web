import { describe, it, expect } from 'vitest';
import {
	extractHeadsFromIndex,
	isSlipNoteTitle,
	validateSlipNoteFormat
} from '$lib/sleepnote/validator.js';
import { createEmptyNote, type NoteData } from '$lib/core/note.js';

function noteWithContent(title: string, inner: string): NoteData {
	const n = createEmptyNote('guid-' + title);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${inner}</note-content>`;
	return n;
}

// Build the inner of a slip note:
// title\n\n이전: <prev>\n다음: <next>\n\n<body>
function slipInner(
	title: string,
	prev: string,
	next: string,
	body = '본문'
): string {
	return `${title}\n\n이전: ${prev}\n다음: ${next}\n\n${body}`;
}

describe('validateSlipNoteFormat', () => {
	it('accepts a well-formed HEAD note (prev=없음, next=link)', () => {
		const n = noteWithContent(
			'Slip-Box::001 제텔카스텐',
			`Slip-Box::001 제텔카스텐\n\n이전: 없음\n다음: <link:internal>Slip-Box::002</link:internal>\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues).toEqual([]);
		expect(r.prev?.kind).toBe('none');
		expect(r.next?.kind).toBe('link');
		expect(r.next?.target).toBe('Slip-Box::002');
	});

	it('accepts a well-formed TAIL note (prev=link, next=없음)', () => {
		const n = noteWithContent(
			'Slip-Box::end',
			`Slip-Box::end\n\n이전: <link:internal>Slip-Box::prev</link:internal>\n다음: 없음\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues).toEqual([]);
		expect(r.prev?.kind).toBe('link');
		expect(r.next?.kind).toBe('none');
	});

	it('accepts an empty string (not "없음") as a none-field', () => {
		const n = noteWithContent(
			'T',
			`T\n\n이전: \n다음: \n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.prev?.kind).toBe('none');
		expect(r.next?.kind).toBe('none');
		expect(r.issues).toEqual([]);
	});

	it('rejects when the title line mismatches note.title', () => {
		const n = noteWithContent(
			'Real Title',
			slipInner('Wrong Title', '없음', '없음')
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'TITLE_MISMATCH')).toBe(true);
	});

	it('rejects when the blank line after title is missing', () => {
		const n = noteWithContent(
			'T',
			`T\n이전: 없음\n다음: 없음\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'MISSING_BLANK_AFTER_TITLE')).toBe(
			true
		);
	});

	it('rejects a note shorter than 5 blocks', () => {
		const n = noteWithContent('T', `T\n\n이전: 없음`);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'TOO_SHORT')).toBe(true);
	});

	it('rejects when 이전 line does not start with "이전:"', () => {
		const n = noteWithContent(
			'T',
			`T\n\nPrev: 없음\n다음: 없음\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'PREV_INVALID')).toBe(true);
	});

	it('rejects when 이전 value is a plain word other than "없음"', () => {
		const n = noteWithContent(
			'T',
			`T\n\n이전: 무언가\n다음: 없음\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		const prev = r.issues.find((i) => i.code === 'PREV_INVALID');
		expect(prev).toBeDefined();
		expect(prev!.message).toMatch(/링크도 '없음'도 아닙니다/);
	});

	it('rejects when 다음 value has trailing text after the link', () => {
		const n = noteWithContent(
			'T',
			`T\n\n이전: 없음\n다음: <link:internal>Some</link:internal> 추가\n\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'NEXT_INVALID')).toBe(true);
	});

	it('rejects when the second blank (before body) is missing', () => {
		const n = noteWithContent(
			'T',
			`T\n\n이전: 없음\n다음: 없음\n본문`
		);
		const r = validateSlipNoteFormat(n);
		expect(r.issues.some((i) => i.code === 'MISSING_BLANK_BEFORE_BODY')).toBe(
			true
		);
	});
});

describe('extractHeadsFromIndex', () => {
	const indexXml = `<note-content version="0.1">File-Box::start-here\n\n소개 문단.\n\n이론\n<list><list-item dir="ltr">과학 <link:internal>메타인지</link:internal>\n<list><list-item dir="ltr">인지 <link:internal>인지 HEAD</link:internal></list-item></list></list-item></list>\n실용\n<list><list-item dir="ltr">노트 <link:internal>제텔카스텐</link:internal></list-item><list-item dir="ltr">건강 <link:internal>호르몬</link:internal></list-item></list>\n기록\n<list><list-item dir="ltr">일기 <link:internal>일상 인덱스</link:internal></list-item></list>\n기타 참고\n<link:internal>사이드 노트</link:internal></note-content>`;

	it('pulls internal links from 이론 / 실용 / 기록 lists', () => {
		const heads = extractHeadsFromIndex(indexXml);
		const titles = heads.map((h) => `${h.section}:${h.title}`);
		expect(titles).toContain('이론:메타인지');
		expect(titles).toContain('이론:인지 HEAD');
		expect(titles).toContain('실용:제텔카스텐');
		expect(titles).toContain('실용:호르몬');
		expect(titles).toContain('기록:일상 인덱스');
	});

	it('ignores links outside of the three sections (e.g. "기타 참고")', () => {
		const heads = extractHeadsFromIndex(indexXml);
		expect(heads.find((h) => h.title === '사이드 노트')).toBeUndefined();
	});

	it('dedupes on (section, title)', () => {
		const dupXml = `<note-content version="0.1">이론\n<list><list-item dir="ltr"><link:internal>A</link:internal></list-item><list-item dir="ltr"><link:internal>A</link:internal></list-item></list></note-content>`;
		const heads = extractHeadsFromIndex(dupXml);
		expect(heads).toHaveLength(1);
		expect(heads[0].title).toBe('A');
	});
});

describe('isSlipNoteTitle', () => {
	it('accepts Slip-Box:: prefixed titles', () => {
		expect(isSlipNoteTitle('Slip-Box::001 제텔카스텐')).toBe(true);
		expect(isSlipNoteTitle('Slip-Box::foo bar')).toBe(true);
	});

	it('accepts yyyy-mm-dd HH:mm prefixed titles', () => {
		expect(isSlipNoteTitle('2025-10-31 11:08 메타인지')).toBe(true);
		expect(isSlipNoteTitle('2024-01-01 00:00 시작')).toBe(true);
	});

	it('trims whitespace before matching', () => {
		expect(isSlipNoteTitle('  Slip-Box::foo')).toBe(true);
	});

	it('rejects other titles', () => {
		expect(isSlipNoteTitle('File-Box::start-here')).toBe(false);
		expect(isSlipNoteTitle('글감')).toBe(false);
		expect(isSlipNoteTitle('자작글 모음')).toBe(false);
		expect(isSlipNoteTitle('')).toBe(false);
		expect(isSlipNoteTitle('2025-10-31')).toBe(false); // no time
		expect(isSlipNoteTitle('2025/10/31 11:08')).toBe(false); // wrong separator
	});
});
