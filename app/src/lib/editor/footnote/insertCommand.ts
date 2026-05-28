/**
 * 각주 삽입 트랜잭션 빌더 — 순수 함수.
 *
 * 알고리즘:
 *  1) Guard — 커서가 제목 단락 안이거나 기존 마커 위치면 abort.
 *  2) 숫자 라벨 매치를 라벨 단위로 그룹핑 (같은 라벨의 모든 참조+정의 = 한 그룹).
 *     새 참조도 가짜 그룹 '__NEW__' 으로 등록, 첫 등장 위치 = 커서.
 *  3) 그룹들을 첫 등장 위치 오름차순으로 정렬 → 1부터 새 라벨 부여.
 *  4) 노드 op (`tr.replaceWith`) 를 from 내림차순으로 정렬해 적용 (뒤따르는 위치 안 어긋남).
 *     새 참조 삽입은 selection.from..selection.to 범위 — 셀렉션이면 자연 대체.
 *  5) 정의 단락 영역을 통째로 재구성 — 기존 정의(새 라벨 적용된 상태) +
 *     새 정의를 라벨 숫자 오름차순으로 정렬해서 doc 끝에 다시 배치.
 *     첫 각주면 `---` 구분선도 함께 삽입.
 *  6) 커서를 새 정의 단락의 [^N] 뒤 (공백 뒤) 로 이동 (정렬 후 위치 기준), scrollIntoView.
 *
 * 비숫자 라벨은 매치 필터에서 제외돼 라벨 자체는 보존되고, 정의 단락
 * 정렬에서는 모든 숫자 정의 뒤로 밀려 원래 상대 순서를 유지한다.
 *
 * Task 6: 텍스트 op (`tr.insertText`) → 노드 op (`tr.replaceWith`) 로 전환.
 * 정의 단락 판정도 정규식 → `defLabelOf` (firstChild type 검사) 로 교체.
 */
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

import { findFootnoteMatches, findFootnoteAt } from './footnotes.js';

export type InsertFootnoteResult =
	| { ok: true; tr: Transaction }
	| { ok: false; reason: 'in-title' | 'inside-existing-marker' };

const NEW_GROUP_KEY = '__NEW__';

type NodeOp = { from: number; to: number; label: string };

function isInTitle(state: EditorState): boolean {
	return state.selection.$from.index(0) === 0;
}

/**
 * 단락의 첫 inline 자식이 footnoteMarker 면 그 label, 아니면 null.
 * 정의 단락 식별은 원본 matches 의 isDefinitionMarker 로 결정되므로
 * 이 헬퍼는 op 적용 후 doc 안에서 라벨만 뽑을 때 쓴다.
 */
function defLabelOf(node: PMNode): string | null {
	const first = node.firstChild;
	if (!first || first.type.name !== 'footnoteMarker') return null;
	return (first.attrs.label as string | undefined) ?? null;
}

export function buildInsertFootnoteTransaction(state: EditorState): InsertFootnoteResult {
	if (isInTitle(state)) return { ok: false, reason: 'in-title' };

	const matches = findFootnoteMatches(state.doc);
	const selFrom = state.selection.from;
	const selTo = state.selection.to;

	// 셀렉션이 없는(=커서) 경우에만 마커-위치 체크. atomic 노드라 pos === from
	// 일 때만 매치된다 — 이전 텍스트 마커 시절의 "마커 안 strictly inside"
	// 의미가 노드 시대에는 "마커 노드 자체 위치"로 좁혀진 것.
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

	const fnType = state.schema.nodes.footnoteMarker;
	const paragraphType = state.schema.nodes.paragraph;

	const ops: NodeOp[] = numericMatches.map((m) => ({
		from: m.from,
		to: m.to,
		label: oldToNew.get(m.label)!
	}));
	ops.push({ from: selFrom, to: selTo, label: newLabel });

	ops.sort((a, b) => b.from - a.from || b.to - a.to);

	const tr = state.tr;
	for (const op of ops) {
		tr.replaceWith(op.from, op.to, fnType.create({ label: op.label }));
	}

	// `matches` (모든 라벨) 사용. 비숫자 정의 마커 (`[^abc] ...`) 도 정의로
	// 인정해서 새 `---` 자동 삽입을 억제한다 — 숫자 리넘버 대상과 정의-존재
	// 판정의 비대칭성은 의도된 것.
	const hasExistingDef = matches.some((m) => m.isDefinitionMarker);

	// 새 정의 단락 = [footnoteMarker(label=newLabel), text(' ')].
	const defPara = paragraphType.create(
		null,
		Fragment.from([fnType.create({ label: newLabel }), state.schema.text(' ')])
	);

	// 정의 단락 식별 — 원본 state 의 isDefinitionMarker 플래그 기준 (본문이
	// 우연히 footnoteMarker 로 시작하는 단락을 def 로 오인하지 않도록). doc 끝의
	// 연속된 블록만 재정렬 대상으로 삼는다 — 산재한 def 는 포맷 규약 밖이라
	// 손대지 않는다.
	const allDefIdx = new Set<number>();
	for (const m of matches) {
		if (m.isDefinitionMarker) allDefIdx.add(state.doc.resolve(m.from).index(0));
	}
	const childCount = tr.doc.childCount;
	let firstDefIdx = childCount;
	for (let i = childCount - 1; i >= 1; i--) {
		if (!allDefIdx.has(i)) break;
		firstDefIdx = i;
	}

	type DefEntry = { node: PMNode; sortKey: number; origIdx: number };
	const existingDefs: DefEntry[] = [];
	let defSectionStart = tr.doc.content.size;
	if (firstDefIdx < childCount) {
		tr.doc.forEach((node, offset, idx) => {
			if (idx < firstDefIdx) return;
			if (idx === firstDefIdx) defSectionStart = offset;
			const lbl = defLabelOf(node);
			if (lbl === null) return;
			existingDefs.push({
				node,
				sortKey: /^\d+$/.test(lbl) ? parseInt(lbl, 10) : Infinity,
				origIdx: idx
			});
		});
	}

	// 새 정의 + 기존 정의 합쳐서 라벨 숫자 오름차순으로 정렬. 비숫자는
	// sortKey = Infinity 라 뒤로 밀리고, 그 안에서는 origIdx 로 안정 정렬.
	const allDefs: DefEntry[] = [
		...existingDefs,
		{ node: defPara, sortKey: parseInt(newLabel, 10), origIdx: childCount }
	];
	allDefs.sort((a, b) =>
		a.sortKey !== b.sortKey ? a.sortKey - b.sortKey : a.origIdx - b.origIdx
	);

	const fragments: PMNode[] = [];
	if (!hasExistingDef) {
		fragments.push(paragraphType.create(null, state.schema.text('---')));
	}
	for (const d of allDefs) fragments.push(d.node);
	tr.replaceWith(defSectionStart, tr.doc.content.size, Fragment.fromArray(fragments));

	// 정렬 후 새 정의가 def-섹션 중간에 끼어들 수 있으므로 라벨로 다시 찾아
	// 그 단락 끝으로 커서 이동.
	let cursorPos = tr.doc.content.size - 1;
	tr.doc.forEach((node, offset, idx) => {
		if (idx === 0) return;
		const lbl = defLabelOf(node);
		if (lbl === newLabel) cursorPos = offset + node.nodeSize - 1;
	});
	tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
	tr.scrollIntoView();

	return { ok: true, tr };
}
