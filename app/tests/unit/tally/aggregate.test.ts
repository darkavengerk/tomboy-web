import { describe, it, expect } from 'vitest';
import { aggregate, scoreBallot } from '$lib/tally';
import type { TallySpec, Ballot } from '$lib/tally';

const spec: TallySpec = {
	title: '테스트',
	questions: [
		{ index: 0, text: '색?', options: ['빨강', '파랑', '초록'], allowMultiple: false, correctIndex: null },
		{ index: 1, text: '수도? ', options: ['서울', '도쿄'], allowMultiple: false, correctIndex: 0 }
	]
};

// Firestore 는 object 키를 문자열로 저장 — 문자열 키 ballot 도 처리되는지 확인.
const ballot = (answers: Record<number, number[]>): Ballot => ({ voterUid: 'u', answers });

describe('aggregate', () => {
	it('보기별 득표 + 응답 수', () => {
		const ballots = [
			ballot({ 0: [0], 1: [0] }),
			ballot({ 0: [1], 1: [1] }),
			ballot({ 0: [0], 1: [0] })
		];
		const r = aggregate(spec, ballots);
		expect(r[0].counts).toEqual([2, 1, 0]);
		expect(r[0].total).toBe(3);
		expect(r[0].correctRate).toBeNull(); // 퀴즈 아님
	});

	it('정답률 — 정확히 {correctIndex} 선택한 표 비율', () => {
		const ballots = [
			ballot({ 1: [0] }), // 정답
			ballot({ 1: [0] }), // 정답
			ballot({ 1: [1] }) // 오답
		];
		const r = aggregate(spec, ballots);
		expect(r[1].counts).toEqual([2, 1]);
		expect(r[1].total).toBe(3);
		expect(r[1].correctRate).toBeCloseTo(2 / 3);
	});

	it('문자열 키(Firestore 직렬화) 표도 집계', () => {
		const ballots: Ballot[] = [{ voterUid: 'u', answers: { '0': [2] } as Record<number, number[]> }];
		expect(aggregate(spec, ballots)[0].counts).toEqual([0, 0, 1]);
	});

	it('미응답 문제는 total/count 에서 제외', () => {
		const ballots = [ballot({ 0: [0] })]; // q1 미응답
		const r = aggregate(spec, ballots);
		expect(r[1].total).toBe(0);
		expect(r[1].correctRate).toBe(0); // 퀴즈인데 응답 0 → 0
	});

	it('중복가능: 한 표가 여러 보기 가산, 정답은 단일 선택만 인정', () => {
		const multi: TallySpec = {
			title: 'm',
			questions: [
				{ index: 0, text: 'Q', options: ['A', 'B', 'C'], allowMultiple: true, correctIndex: 0 }
			]
		};
		const ballots = [
			ballot({ 0: [0] }), // 정답(단일)
			ballot({ 0: [0, 1] }) // A 포함하지만 다중 → 오답
		];
		const r = aggregate(multi, ballots);
		expect(r[0].counts).toEqual([2, 1, 0]);
		expect(r[0].total).toBe(2);
		expect(r[0].correctRate).toBeCloseTo(1 / 2);
	});
});

describe('scoreBallot', () => {
	it('퀴즈 문제만 채점', () => {
		expect(scoreBallot(spec, { 0: [1], 1: [0] })).toEqual({ correct: 1, scored: 1 });
		expect(scoreBallot(spec, { 0: [1], 1: [1] })).toEqual({ correct: 0, scored: 1 });
	});
	it('퀴즈 없으면 scored=0', () => {
		const noQuiz: TallySpec = {
			title: 'x',
			questions: [{ index: 0, text: 'Q', options: ['A', 'B'], allowMultiple: false, correctIndex: null }]
		};
		expect(scoreBallot(noQuiz, { 0: [0] })).toEqual({ correct: 0, scored: 0 });
	});
});
