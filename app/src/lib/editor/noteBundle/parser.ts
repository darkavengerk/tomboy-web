/**
 * 묶음 파서.
 *
 * `[prefix:]<체크박스>묶음:N` 키워드 paragraph (prefix 는 비었거나 ':' 로 끝나는 텍스트,
 * 옛 `노트 묶음` 표기도 허용) + 직후 bulletList(내부 링크 항목)를 라이브 PMNode
 * 워크로 찾아 BundleSpec[] 로 반환.
 * 체크박스는 atom 노드라 plain-JSON 텍스트 스캔으로는 보이지 않는다 — 노드 트리를 걷는다.
 *
 * 리스트는 **트리**(BundleNode[])로 파싱된다 — 탭(파일철) UI 가 재귀적이기 때문.
 * - 한 줄(리스트아이템)의 모든 내부 링크(쉼표/공백 구분)가 각각 잎 노드.
 * - 중첩 리스트가 있는 항목은 **카테고리** 노드: 그 항목의 전체 타이틀이 label,
 *   children = [자기 링크(있으면) 먼저, 그 뒤 중첩 리스트를 재귀 파싱].
 *
 * 활성 노트(어떤 탭이 열렸는지)는 영속하지 않는다 — 컴포넌트 로컬 상태.
 * 파서는 리스트 내용을 읽기만 한다(위치/선택 정보 없음).
 *
 * 순수 함수: IDB/타이틀 인덱스 접근 없음. guid 해석은 NoteBundleStack 이
 * lookupGuidByTitle 로 수행.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface BundleNode {
	/** 탭 라벨 — 카테고리면 항목 전체 타이틀, 잎이면 링크 타이틀 */
	label: string;
	/** 이 노드가 그 자체로 여는 노트(내부링크 target). 순수 카테고리면 null */
	link: string | null;
	/** 하위 탭(카테고리 children). 잎이면 빈 배열 */
	children: BundleNode[];
}

export interface BundleSpec {
	ordinal: number;
	checkboxPos: number;
	checked: boolean;
	/** 20–90 클램프, 생략 시 50 */
	heightPct: number;
	/** `:` 뒤 숫자 텍스트 범위 — 높이 쓰기백 대상. 숫자 없으면 from===to */
	digitsFrom: number;
	digitsTo: number;
	/** 키워드 paragraph 끝 pos — 리스트 없을 때 위젯 fallback 위치 */
	keywordEnd: number;
	listPos: number | null;
	listEnd: number | null;
	/** 최상위 노드들(트리 루트). 빈 리스트면 [] */
	tree: BundleNode[];
}

export const DEFAULT_HEIGHT_PCT = 50;

export function clampHeightPct(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_HEIGHT_PCT;
	return Math.min(90, Math.max(20, Math.round(n)));
}

// `묶음:N` 또는 옛 표기 `노트 묶음:N` (하위호환). `노트` 접두는 선택.
const KEYWORD_RE = /^\s*(?:노트\s*)?묶음:(\d+)?\s*$/;

interface KeywordInfo {
	checkboxPos: number;
	checked: boolean;
	heightPct: number;
	digitsFrom: number;
	digitsTo: number;
	keywordEnd: number;
}

function keywordAfterCheckbox(
	para: PMNode,
	paraPos: number,
	cbIndex: number,
	checkboxPos: number
): KeywordInfo | null {
	const cb = para.child(cbIndex);
	let text = '';
	for (let i = cbIndex + 1; i < para.childCount; i++) {
		const c = para.child(i);
		if (!c.isText) return null;
		text += c.text ?? '';
	}
	const m = KEYWORD_RE.exec(text);
	if (!m) return null;
	const colonIdx = text.indexOf(':');
	const digitsLen = m[1]?.length ?? 0;
	// 키워드 텍스트 시작 abs pos = 체크박스 pos + nodeSize(1)
	const textBase = checkboxPos + 1;
	return {
		checkboxPos,
		checked: cb.attrs.checked === true,
		heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : DEFAULT_HEIGHT_PCT,
		digitsFrom: textBase + colonIdx + 1,
		digitsTo: textBase + colonIdx + 1 + digitsLen,
		keywordEnd: paraPos + para.nodeSize
	};
}

function parseKeywordParagraph(para: PMNode, paraPos: number): KeywordInfo | null {
	if (para.childCount < 2) return null;
	// prefix(체크박스 앞 텍스트)가 trim 후 비었거나 ':' 로 끝나고, 뒤따르는
	// 텍스트가 KEYWORD_RE 에 매칭되는 첫 inlineCheckbox 를 찾는다 —
	// `Done:[ ]묶음:` 같은 TODO/Process prefix 조합 허용.
	// atom(앞쪽의 다른 체크박스 등)은 prefix 텍스트에 기여하지 않는다.
	let prefix = '';
	let offset = 0;
	for (let i = 0; i < para.childCount; i++) {
		const child = para.child(i);
		if (child.type.name === 'inlineCheckbox') {
			const trimmed = prefix.trim();
			if (trimmed === '' || trimmed.endsWith(':')) {
				const info = keywordAfterCheckbox(para, paraPos, i, paraPos + 1 + offset);
				if (info) return info;
			}
		}
		if (child.isText) prefix += child.text ?? '';
		offset += child.nodeSize;
	}
	return null;
}

/** paragraph 의 텍스트 노드만 이어붙여 trim — 카테고리 라벨용.
 *  링크 텍스트는 그대로 포함되므로 "프로젝트 [[A]]" → "프로젝트 A". */
function paragraphText(para: PMNode): string {
	let s = '';
	para.forEach((c) => {
		if (c.isText) s += c.text ?? '';
	});
	return s.trim();
}

/** paragraph 안의 모든 내부 링크 target 을 등장 순서대로 수집.
 *  인접한 같은 target 텍스트 노드는 한 링크로 본다(마크 분할 무관).
 *  비-링크 텍스트/atom 은 스팬을 끊는다 — 같은 줄의 쉼표/공백으로 나뉜
 *  서로 다른 링크가 각각 잡힌다. */
function collectLinks(para: PMNode): string[] {
	const out: string[] = [];
	let lastTarget: string | null = null;
	para.forEach((child) => {
		if (!child.isText) {
			lastTarget = null;
			return;
		}
		const mark = child.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
		const target = mark?.attrs.target ? String(mark.attrs.target) : null;
		if (target && target !== lastTarget) out.push(target);
		lastTarget = target;
	});
	return out;
}

/** 리스트를 트리(BundleNode[])로 재귀 파싱.
 *  - 중첩 리스트 있는 항목 → 카테고리 노드(label=항목 전체 타이틀,
 *    children=[자기 링크 잎…, 중첩 재귀…]).
 *  - 중첩 없는 항목 → 항목의 각 링크가 형제 잎. 링크 없으면 노드 없음. */
function parseList(list: PMNode): BundleNode[] {
	const out: BundleNode[] = [];
	list.forEach((li) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		const isPara = para.type.name === 'paragraph';
		const links = isPara ? collectLinks(para) : [];
		const title = isPara ? paragraphText(para) : '';
		let nested: PMNode | null = null;
		for (let ci = 0; ci < li.childCount; ci++) {
			const c = li.child(ci);
			if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
				nested = c;
				break;
			}
		}
		if (nested) {
			// 카테고리 노드 — 자기 링크가 첫 children(자신을 첫 탭으로), 그 뒤 중첩.
			const children: BundleNode[] = [];
			for (const L of links) children.push({ label: L, link: L, children: [] });
			children.push(...parseList(nested));
			out.push({ label: title || links[0] || '', link: null, children });
		} else {
			for (const L of links) out.push({ label: L, link: L, children: [] });
		}
	});
	return out;
}

export function parseNoteBundles(doc: PMNode): BundleSpec[] {
	const out: BundleSpec[] = [];
	let pending: KeywordInfo | null = null;

	const flush = (list: PMNode | null, listPos: number | null) => {
		if (!pending) return;
		out.push({
			ordinal: out.length,
			checkboxPos: pending.checkboxPos,
			checked: pending.checked,
			heightPct: pending.heightPct,
			digitsFrom: pending.digitsFrom,
			digitsTo: pending.digitsTo,
			keywordEnd: pending.keywordEnd,
			listPos,
			listEnd: list && listPos !== null ? listPos + list.nodeSize : null,
			tree: list ? parseList(list) : []
		});
		pending = null;
	};

	doc.forEach((node, offset, index) => {
		if (pending) {
			if (node.type.name === 'bulletList') {
				flush(node, offset);
				return;
			}
			flush(null, null);
		}
		// index 0 = 제목 라인 — 번들 키워드로 취급하지 않는다
		if (index === 0) return;
		if (node.type.name === 'paragraph') {
			pending = parseKeywordParagraph(node, offset);
		}
	});
	flush(null, null);
	return out;
}
