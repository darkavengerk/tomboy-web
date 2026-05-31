/**
 * 각주 마커 노드 탐색 (순수 함수).
 *
 * footnoteMarker 는 atomic inline 노드. 본문 어디든 등장하면 "참조"(ref),
 * 최상위 paragraph (제목 idx 0 제외) 의 첫 비공백 inline 이면 "설명 마커"(def).
 * 리스트 등 깊은 컨테이너 안의 마커는 항상 ref.
 *
 * archiver 가 외부 텍스트 [^N] 을 노드로 변환하므로 이 파일은 노드만 본다.
 * 정의 마커 판정은 node.ts 의 isDefinitionResolved 와 같은 규칙을 쓴다.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

import { isDefinitionResolved } from './node.js';

export interface FootnoteMatch {
	/** 노드 시작 절대 위치 (노드 자체의 위치). */
	from: number;
	/** 노드 끝 절대 위치 (from + 1, atomic). */
	to: number;
	/** 노드의 label attr. */
	label: string;
	/** 최상위 paragraph 의 첫 비공백 inline 이면 true. */
	isDefinitionMarker: boolean;
}

/** 문서 전체의 각주 매치를 문서 순서대로 반환. 제목 (idx 0) 제외. */
export function findFootnoteMatches(doc: PMNode): FootnoteMatch[] {
	const out: FootnoteMatch[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== 'footnoteMarker') return true;
		const $pos = doc.resolve(pos);
		// 제목 (top idx 0) 제외 — top-level idx 0 단락 안의 마커는 결과에서 빠진다.
		if ($pos.index(0) === 0) return false;
		out.push({
			from: pos,
			to: pos + node.nodeSize,
			label: (node.attrs.label as string | undefined) ?? '',
			isDefinitionMarker: isDefinitionResolved($pos)
		});
		return false;
	});
	return out;
}

/**
 * 위치 `pos` 를 포함하는 매치. atomic 노드라 pos === from 일 때만 매치.
 * (이전 데코레이션 구현은 마커 내부 위치들도 매치했지만, 노드는 from 이 유일.)
 */
export function findFootnoteAt(
	matches: FootnoteMatch[],
	pos: number
): FootnoteMatch | null {
	for (const m of matches) {
		if (pos === m.from) return m;
	}
	return null;
}

/**
 * 짝(ref↔def) 찾기 — 라벨 같은 매치 중 가장 가까운 것.
 *  - 참조 클릭     → 자신보다 뒤에 오는 첫 설명 마커
 *  - 설명 마커 클릭 → 자신보다 앞에 오는 마지막 참조
 * `matches` 는 문서 순서로 정렬돼 있어야 한다 (findFootnoteMatches 의 반환값이 그렇다).
 */
export function findFootnotePartner(
	matches: FootnoteMatch[],
	clicked: FootnoteMatch
): FootnoteMatch | null {
	if (!clicked.isDefinitionMarker) {
		for (const m of matches) {
			if (
				m.label === clicked.label &&
				m.isDefinitionMarker &&
				m.from > clicked.from
			) {
				return m;
			}
		}
		return null;
	}
	let found: FootnoteMatch | null = null;
	for (const m of matches) {
		if (
			m.label === clicked.label &&
			!m.isDefinitionMarker &&
			m.from < clicked.from
		) {
			found = m;
		}
	}
	return found;
}

/**
 * 설명 마커가 위치한 단락의 텍스트를 미리보기용으로 추출.
 *
 * footnoteMarker 는 atomic leaf 노드라 `textContent` 에 라벨을 기여하지
 * 않는다 — 단락 텍스트는 이미 마커를 뺀 순수 설명 본문이다. trim 후
 * `maxLen`(기본 120) 초과 시 … 로 말줄임한다.
 */
export function getDefinitionPreviewText(
	doc: PMNode,
	defMatch: FootnoteMatch,
	maxLen = 120
): string {
	const block = doc.resolve(defMatch.from + 1).parent;
	const stripped = block.textContent.trim();
	if (stripped.length <= maxLen) return stripped;
	return stripped.slice(0, maxLen) + '…';
}
