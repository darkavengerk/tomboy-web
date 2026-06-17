/**
 * 표 집계 — 클라이언트에서 ballot 배열을 문제별 결과로.
 *
 * Firestore object 키는 문자열로 저장되므로 answers[q.index] 접근 시 number→string
 * 강제변환(JS 객체 규칙)에 의존한다.
 */
import type { TallySpec, Ballot, QuestionResult } from './types.js';

/** 퀴즈 정답 판정: 선택 집합이 정확히 {correctIndex} 일 때만 정답. */
function isCorrect(answer: number[], correctIndex: number): boolean {
	return answer.length === 1 && answer[0] === correctIndex;
}

export function aggregate(spec: TallySpec, ballots: Ballot[]): QuestionResult[] {
	return spec.questions.map((q) => {
		const counts = new Array(q.options.length).fill(0);
		let total = 0;
		let correct = 0;
		for (const b of ballots) {
			const ans = b.answers?.[q.index];
			if (!ans || ans.length === 0) continue;
			total++;
			for (const o of ans) {
				if (o >= 0 && o < counts.length) counts[o]++;
			}
			if (q.correctIndex !== null && isCorrect(ans, q.correctIndex)) correct++;
		}
		return {
			counts,
			total,
			correctRate: q.correctIndex !== null ? (total > 0 ? correct / total : 0) : null
		};
	});
}

/** 한 투표자의 퀴즈 점수 — {정답수, 채점된 문제수}. */
export function scoreBallot(spec: TallySpec, answers: Record<number, number[]>): {
	correct: number;
	scored: number;
} {
	let correct = 0;
	let scored = 0;
	for (const q of spec.questions) {
		if (q.correctIndex === null) continue;
		scored++;
		const ans = answers?.[q.index];
		if (ans && isCorrect(ans, q.correctIndex)) correct++;
	}
	return { correct, scored };
}
