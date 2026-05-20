/**
 * 각주 마커 [^라벨] 탐색 (순수 함수).
 *
 * 본문 어디든 나오는 [^N] 은 "참조"(작은 위첨자로 표시), 최상위 단락의
 * 맨 앞(선행 공백 제외)에 오는 [^N] 은 "설명 마커"(일반 크기로 표시)다.
 * 역할은 표시 크기와 클릭 시 짝(스크롤 대상) 결정에 쓰인다. 제목(0번
 * 단락)은 제외한다.
 *
 * 마커는 라이브 문서와 .note XML 양쪽에 평범한 텍스트로 남는다 —
 * 아카이버(noteContentArchiver.ts)는 이 파일을 거치지 않는다.
 *
 * 한계: 마크(굵게 등) 경계가 마커 안에서 끊기면(예: `[^` 굵게, `7]` 일반)
 * 해당 마커는 탐지되지 않는다. 데코레이션 전용 방식의 알려진 트레이드오프.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** [^라벨] — 라벨은 ] 와 공백이 아닌 1자 이상. */
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g;

export interface FootnoteMatch {
	/** 매치 시작 절대 위치 ('[' 앞). */
	from: number;
	/** 매치 끝 절대 위치 (']' 뒤). */
	to: number;
	/** [^ 와 ] 사이의 라벨 텍스트. */
	label: string;
	/** 최상위 단락의 맨 앞(선행 공백 제외)에 오면 true. */
	isDefinitionMarker: boolean;
}

/**
 * 한 textblock 의 인라인 텍스트에서 [^N] 매치를 모은다. `canBeDefinition`
 * 이 true 면 블록 맨 앞(선행 공백 제외)의 매치는 설명 마커로 표시된다.
 */
function scanTextblock(
	block: PMNode,
	blockPos: number,
	canBeDefinition: boolean,
	out: FootnoteMatch[]
): void {
	const contentStart = blockPos + 1;
	let rel = 0;
	let sawContent = false;
	block.forEach((child) => {
		if (child.isText && child.text != null) {
			const text = child.text;
			FOOTNOTE_RE.lastIndex = 0;
			let lastIdx = 0;
			let m: RegExpExecArray | null;
			while ((m = FOOTNOTE_RE.exec(text)) !== null) {
				if (/\S/.test(text.slice(lastIdx, m.index))) sawContent = true;
				const from = contentStart + rel + m.index;
				out.push({
					from,
					to: from + m[0].length,
					label: m[1],
					isDefinitionMarker: canBeDefinition && !sawContent
				});
				sawContent = true;
				lastIdx = m.index + m[0].length;
			}
			if (/\S/.test(text.slice(lastIdx))) sawContent = true;
		} else {
			// 텍스트 아닌 인라인 노드(hardBreak 등)는 내용으로 친다.
			sawContent = true;
		}
		rel += child.nodeSize;
	});
}

/** 문서 전체의 각주 매치를 문서 순서대로 반환. 제목(0번 단락) 제외. */
export function findFootnoteMatches(doc: PMNode): FootnoteMatch[] {
	const out: FootnoteMatch[] = [];
	doc.forEach((topNode, offset, index) => {
		if (index === 0) return; // 제목 단락 제외
		if (topNode.isTextblock) {
			scanTextblock(
				topNode,
				offset,
				topNode.type.name === 'paragraph',
				out
			);
		} else {
			// 리스트 등 컨테이너 — 내부 textblock 스캔, 설명 마커는 불가.
			topNode.descendants((n, p) => {
				if (n.isTextblock) {
					scanTextblock(n, offset + 1 + p, false, out);
					return false;
				}
				return true;
			});
		}
	});
	return out;
}

/** 위치 `pos` 를 포함하는 매치를 반환(없으면 null). */
export function findFootnoteAt(
	matches: FootnoteMatch[],
	pos: number
): FootnoteMatch | null {
	for (const m of matches) {
		if (pos > m.from && pos < m.to) return m;
	}
	return null;
}

/**
 * 클릭된 매치의 짝을 반환. 한 노트에 여러 문서가 있어 각주 라벨이 겹칠
 * 수 있으므로(문서끼리 인터리브하지 않는다고 가정), 라벨이 같은 매치
 * 중 위치가 가장 가까운 것을 고른다:
 *  - 참조 클릭     → 자신보다 뒤에 오는 첫 설명 마커
 *  - 설명 마커 클릭 → 자신보다 앞에 오는 마지막 참조
 * 짝이 없으면 null. `matches` 는 문서 순서로 정렬돼 있어야 한다
 * (findFootnoteMatches 의 반환값이 그렇다).
 */
export function findFootnotePartner(
	matches: FootnoteMatch[],
	clicked: FootnoteMatch
): FootnoteMatch | null {
	if (!clicked.isDefinitionMarker) {
		// 참조 → 뒤따르는 첫 설명 마커(같은 라벨).
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
	// 설명 마커 → 앞서는 마지막 참조(같은 라벨).
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
