import { describe, it, expect } from 'vitest';
import { isTallyTitle, tallyName, parseTallyNote } from '$lib/tally';

// --- JSON 빌더(에디터 불필요 — 파서는 JSONContent 를 직접 소비) -------------
const doc = (...blocks: object[]) => ({ type: 'doc', content: blocks });
const title = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const para = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
const li = (t: string) => ({ type: 'listItem', content: [para(t)] });
const ul = (...items: string[]) => ({ type: 'bulletList', content: items.map(li) });

describe('isTallyTitle / tallyName', () => {
	it('집계:: 접두 인식 + 선행 공백', () => {
		expect(isTallyTitle('집계::설문')).toBe(true);
		expect(isTallyTitle('  집계::x')).toBe(true);
		expect(isTallyTitle('집계:x')).toBe(false);
		expect(isTallyTitle('투표')).toBe(false);
		expect(isTallyTitle('')).toBe(false);
	});
	it('tallyName = 접두 제거', () => {
		expect(tallyName('집계::점심 메뉴')).toBe('점심 메뉴');
		expect(tallyName('  집계::  공백 ')).toBe('공백');
	});
});

describe('parseTallyNote — 문제/보기/설정', () => {
	it('단순 문제: 단락 + 직후 리스트', () => {
		const d = doc(title('집계::설문'), para('좋아하는 색?'), ul('빨강', '파랑', '초록'));
		const spec = parseTallyNote(d, '집계::설문');
		expect(spec.title).toBe('설문');
		expect(spec.questions).toHaveLength(1);
		expect(spec.questions[0]).toEqual({
			index: 0,
			text: '좋아하는 색?',
			options: ['빨강', '파랑', '초록'],
			allowMultiple: false,
			correctIndex: null
		});
	});

	it('중복가능 토큰', () => {
		const d = doc(title('집계::x'), para('아무거나 |중복가능'), ul('A', 'B'));
		const q = parseTallyNote(d, '집계::x').questions[0];
		expect(q.text).toBe('아무거나');
		expect(q.allowMultiple).toBe(true);
		expect(q.correctIndex).toBeNull();
	});

	it('정답:N → 0-based correctIndex (퀴즈)', () => {
		const d = doc(title('집계::퀴즈'), para('수도? |정답:2'), ul('서울', '도쿄', '베이징'));
		const q = parseTallyNote(d, '집계::퀴즈').questions[0];
		expect(q.text).toBe('수도?');
		expect(q.correctIndex).toBe(1); // 2 → 인덱스 1
	});

	it('중복가능 + 정답 동시', () => {
		const d = doc(title('집계::x'), para('Q |중복가능|정답:1'), ul('A', 'B'));
		const q = parseTallyNote(d, '집계::x').questions[0];
		expect(q.allowMultiple).toBe(true);
		expect(q.correctIndex).toBe(0);
	});

	it('범위 밖 정답 인덱스는 무효(null)', () => {
		const d = doc(title('집계::x'), para('Q |정답:9'), ul('A', 'B'));
		expect(parseTallyNote(d, '집계::x').questions[0].correctIndex).toBeNull();
	});

	it('여러 문제 — index 순차 부여', () => {
		const d = doc(
			title('집계::멀티'),
			para('Q1'),
			ul('A', 'B'),
			para('Q2 |중복가능'),
			ul('C', 'D', 'E')
		);
		const qs = parseTallyNote(d, '집계::멀티').questions;
		expect(qs.map((q) => q.index)).toEqual([0, 1]);
		expect(qs[1].options).toEqual(['C', 'D', 'E']);
		expect(qs[1].allowMultiple).toBe(true);
	});

	it('리스트 안 따라오는 단락은 무시', () => {
		const d = doc(title('집계::x'), para('설명만 있는 줄'), para('Q'), ul('A', 'B'));
		const qs = parseTallyNote(d, '집계::x').questions;
		expect(qs).toHaveLength(1);
		expect(qs[0].text).toBe('Q');
	});

	it('빈 보기 리스트는 문제로 치지 않음', () => {
		const d = doc(title('집계::x'), para('Q'), ul());
		expect(parseTallyNote(d, '집계::x').questions).toHaveLength(0);
	});

	it('빈 본문 → 문제 0개', () => {
		expect(parseTallyNote(doc(title('집계::x')), '집계::x').questions).toEqual([]);
	});
});
