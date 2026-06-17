/**
 * 집계(투표/퀴즈) 전용 노트 타입.
 *
 * 노트 제목 `집계::<제목>` + 본문 = 문제들. 문제 하나 = 단락(`문제 텍스트
 * |중복가능|정답:N`) + 직후 bulletList(보기들). 순수 뷰 레이어 — 노트 XML 은
 * 그대로, 투표 데이터만 별도 Firestore `polls/{noteGuid}` 에 산다.
 */

/** 파싱된 문제 하나. index = 노트 안 문제 순번(투표 키). */
export interface TallyQuestion {
	/** 문제 순번(0-based) — ballot 의 answers 키. 문제 재정렬 시 어긋남. */
	index: number;
	/** 설정 토큰(`|…`)을 떼어낸 문제 본문 */
	text: string;
	/** 보기 라벨들(평문) */
	options: string[];
	/** `|중복가능` → 다중 선택 허용 */
	allowMultiple: boolean;
	/** `|정답:N` → 정답 보기 인덱스(0-based). 없으면 null(= 일반 투표) */
	correctIndex: number | null;
}

export interface TallySpec {
	/** `집계::` 를 뗀 투표 제목 */
	title: string;
	questions: TallyQuestion[];
}

/** 한 투표자의 표 — answers[문제순번] = 선택한 보기 인덱스 배열. */
export interface Ballot {
	voterUid: string;
	answers: Record<number, number[]>;
}

/** Firestore `polls/{noteGuid}` 메타 문서. */
export interface PollMeta {
	ownerUid: string;
	resultsPublic: boolean;
}

/** 문제 하나의 집계 결과. */
export interface QuestionResult {
	/** 보기별 득표수 */
	counts: number[];
	/** 이 문제에 답한 표 수 */
	total: number;
	/** 정답률(0~1). 퀴즈가 아니면 null */
	correctRate: number | null;
}
