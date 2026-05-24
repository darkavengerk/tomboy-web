/**
 * 각주 삽입 트랜잭션 빌더 — 순수 함수.
 *
 * 알고리즘:
 *  1) Guard — 커서가 제목 단락 안이거나 기존 마커 내부면 abort.
 *  2) 숫자 라벨 매치를 라벨 단위로 그룹핑 (같은 라벨의 모든 참조+정의 = 한 그룹).
 *     새 참조도 가짜 그룹 '__NEW__' 으로 등록, 첫 등장 위치 = 커서.
 *  3) 그룹들을 첫 등장 위치 오름차순으로 정렬 → 1부터 새 라벨 부여.
 *  4) 치환 + 삽입 작업을 from 내림차순으로 정렬해 적용 (뒤따르는 위치 안 어긋남).
 *     새 참조 삽입은 selection.from..selection.to 범위 — 셀렉션이면 자연 대체.
 *  5) 정의 단락 (+ 첫 각주면 ---) 을 본문 끝에 추가.
 *  6) 커서를 새 정의 단락의 [^N] 뒤 (공백 뒤) 로 이동, scrollIntoView.
 *
 * 비숫자 라벨은 매치 필터에서 제외돼 그대로 보존된다.
 */
import { Fragment } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

import { findFootnoteMatches, findFootnoteAt } from './footnotes.js';

export type InsertFootnoteResult =
	| { ok: true; tr: Transaction }
	| { ok: false; reason: 'in-title' | 'inside-existing-marker' };

const NEW_GROUP_KEY = '__NEW__';

type Op = { from: number; to: number; text: string };

function isInTitle(state: EditorState): boolean {
	return state.selection.$from.index(0) === 0;
}

export function buildInsertFootnoteTransaction(state: EditorState): InsertFootnoteResult {
	if (isInTitle(state)) return { ok: false, reason: 'in-title' };

	const matches = findFootnoteMatches(state.doc);
	const selFrom = state.selection.from;
	const selTo = state.selection.to;

	// 셀렉션이 없는(=커서) 경우에만 마커-내부 체크.
	if (selFrom === selTo) {
		if (findFootnoteAt(matches, selFrom)) {
			return { ok: false, reason: 'inside-existing-marker' };
		}
	}

	const numericMatches = matches.filter((m) => /^\d+$/.test(m.label));
	const groupFirstPos = new Map<string, number>();
	for (const m of numericMatches) {
		if (!groupFirstPos.has(m.label)) groupFirstPos.set(m.label, m.from);
	}
	groupFirstPos.set(NEW_GROUP_KEY, selFrom);

	// 커서가 기존 각주 그룹 사이에 삽입될 때 (cursor > 첫 그룹 위치) __NEW__ 가
	// 동일-위치 그룹보다 앞서 번호를 가져간다. 커서가 첫 그룹 위치와 같으면
	// 기존 그룹이 이미 그 위치를 "소유"하므로 stable 순서(기존 먼저)를 유지한다.
	let minNumericPos = Infinity;
	for (const [key, pos] of groupFirstPos) {
		if (key !== NEW_GROUP_KEY && pos < minNumericPos) minNumericPos = pos;
	}
	const newWinsTie = selFrom > minNumericPos;
	const ordered = [...groupFirstPos.entries()].sort((a, b) => {
		if (a[1] !== b[1]) return a[1] - b[1];
		// 동위일 때: newWinsTie 면 __NEW__ 먼저, 아니면 기존 그룹 먼저.
		if (a[0] === NEW_GROUP_KEY) return newWinsTie ? -1 : 1;
		if (b[0] === NEW_GROUP_KEY) return newWinsTie ? 1 : -1;
		return 0;
	});
	const oldToNew = new Map<string, string>();
	ordered.forEach(([key], i) => oldToNew.set(key, String(i + 1)));
	const newLabel = oldToNew.get(NEW_GROUP_KEY)!;

	const ops: Op[] = numericMatches.map((m) => ({
		from: m.from,
		to: m.to,
		text: `[^${oldToNew.get(m.label)}]`
	}));
	ops.push({ from: selFrom, to: selTo, text: `[^${newLabel}]` });

	ops.sort((a, b) => b.from - a.from || b.to - a.to);

	const tr = state.tr;
	for (const op of ops) tr.insertText(op.text, op.from, op.to);

	// `matches` (모든 라벨) 사용. 비숫자 정의 마커 (`[^abc] ...`) 도 정의로
	// 인정해서 새 `---` 자동 삽입을 억제한다 — 숫자 리넘버 대상과 정의-존재
	// 판정의 비대칭성은 의도된 것.
	const hasExistingDef = matches.some((m) => m.isDefinitionMarker);
	const paragraphType = state.schema.nodes.paragraph;
	const defPara = paragraphType.create(null, state.schema.text(`[^${newLabel}] `));
	const toInsert = hasExistingDef
		? [defPara]
		: [paragraphType.create(null, state.schema.text('---')), defPara];
	tr.insert(tr.doc.content.size, Fragment.fromArray(toInsert));

	const cursorPos = tr.doc.content.size - 1;
	tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
	tr.scrollIntoView();

	return { ok: true, tr };
}
