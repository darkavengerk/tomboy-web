/**
 * 묶음/탭 파서 — 두 종류의 인-에디터 파일철.
 *
 * `[prefix:]<체크박스>탭:N`  → kind 'tab'   : 재귀 브라우저-탭 파일철(NoteBundleStack)
 * `[prefix:]<체크박스>묶음:N` → kind 'bundle' : 5칸 타이틀-윈도우 서류함(NoteBundleCabinet)
 *
 * prefix 는 비었거나 ':' 로 끝나는 텍스트, 옛 `노트 ` 접두도 허용
 * (`노트 탭:` / `노트 묶음:`). 키워드 paragraph + 직후 bulletList(내부 링크
 * 항목)를 라이브 PMNode 워크로 찾아 BundleSpec[] 로 반환.
 * 체크박스는 atom 노드라 plain-JSON 텍스트 스캔으로는 보이지 않는다 — 노드 트리를 걷는다.
 *
 * 두 UI 는 같은 리스트를 서로 다른 모양으로 소비한다:
 * - 'tab'    → tree(BundleNode[]): 중첩 = 카테고리 탭 레벨(재귀).
 * - 'bundle' → entries(BundleEntry[]): 중첩을 평탄화, 부모 타이틀 = category 표시.
 * kind 에 맞는 필드만 채운다(다른 쪽은 빈 배열).
 *
 * 활성 노트(어떤 탭/항목이 열렸는지)는 영속하지 않는다 — 컴포넌트 로컬 상태.
 * 파서는 리스트 내용을 읽기만 한다(위치/선택 정보 없음).
 *
 * 순수 함수: IDB/타이틀 인덱스 접근 없음. guid 해석은 스택 컴포넌트가
 * lookupGuidByTitle 로 수행.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export type BundleKind = 'tab' | 'bundle';

/** 'tab' 트리 노드 — 카테고리(children 보유) 또는 잎(link 보유). */
export interface BundleNode {
	/** 탭 라벨 — 카테고리면 항목 전체 타이틀, 잎이면 링크 타이틀 */
	label: string;
	/** 이 노드가 그 자체로 여는 노트(내부링크 target). 순수 카테고리면 null */
	link: string | null;
	/** 하위 탭(카테고리 children). 잎이면 빈 배열 */
	children: BundleNode[];
}

/** 'bundle' 평탄 엔트리 — 중첩 리스트는 category 로만 표시. */
export interface BundleEntry {
	/** tomboyInternalLink mark 의 target (= 대상 노트 제목) */
	title: string;
	/** 부모(상위 들여쓰기) 항목의 전체 타이틀 — 바에 우측정렬 표시. 없으면 null */
	category: string | null;
}

export interface BundleSpec {
	ordinal: number;
	/** 'tab' = 재귀 탭(NoteBundleStack), 'bundle' = 5칸 윈도우 서류함(NoteBundleCabinet) */
	kind: BundleKind;
	checkboxPos: number;
	checked: boolean;
	/** 20–90 클램프, 생략 시 50 */
	heightPct: number;
	/** `:` 뒤 숫자 텍스트 범위 — 높이 쓰기백 대상. 숫자 없으면 from===to */
	digitsFrom: number;
	digitsTo: number;
	/** 키워드 paragraph 시작 pos — 체크 시 선언 라인 숨김 노드 데코 대상 */
	keywordPos: number;
	/** 키워드 paragraph 끝 pos — 리스트 없을 때 위젯 fallback 위치 */
	keywordEnd: number;
	listPos: number | null;
	listEnd: number | null;
	/** kind==='tab' 일 때만 채워짐(최상위 트리 노드들). 아니면 [] */
	tree: BundleNode[];
	/** kind==='bundle' 일 때만 채워짐(평탄 엔트리). 아니면 [] */
	entries: BundleEntry[];
}

export const DEFAULT_HEIGHT_PCT = 50;

export function clampHeightPct(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_HEIGHT_PCT;
	return Math.min(90, Math.max(20, Math.round(n)));
}

// `탭:N` / `묶음:N` (옛 `노트 ` 접두 허용). `노트` 접두는 선택.
const TAB_RE = /^\s*(?:노트\s*)?탭:(\d+)?\s*$/;
const BUNDLE_RE = /^\s*(?:노트\s*)?묶음:(\d+)?\s*$/;

interface KeywordInfo {
	kind: BundleKind;
	checkboxPos: number;
	checked: boolean;
	heightPct: number;
	digitsFrom: number;
	digitsTo: number;
	keywordPos: number;
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
	const tab = TAB_RE.exec(text);
	const m = tab ?? BUNDLE_RE.exec(text);
	if (!m) return null;
	const kind: BundleKind = tab ? 'tab' : 'bundle';
	const colonIdx = text.indexOf(':');
	const digitsLen = m[1]?.length ?? 0;
	// 키워드 텍스트 시작 abs pos = 체크박스 pos + nodeSize(1)
	const textBase = checkboxPos + 1;
	return {
		kind,
		checkboxPos,
		checked: cb.attrs.checked === true,
		heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : DEFAULT_HEIGHT_PCT,
		digitsFrom: textBase + colonIdx + 1,
		digitsTo: textBase + colonIdx + 1 + digitsLen,
		keywordPos: paraPos,
		keywordEnd: paraPos + para.nodeSize
	};
}

function parseKeywordParagraph(para: PMNode, paraPos: number): KeywordInfo | null {
	if (para.childCount < 2) return null;
	// prefix(체크박스 앞 텍스트)가 trim 후 비었거나 ':' 로 끝나고, 뒤따르는
	// 텍스트가 키워드 RE 에 매칭되는 첫 inlineCheckbox 를 찾는다 —
	// `Done:[ ]탭:` 같은 TODO/Process prefix 조합 허용.
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

// ── 'tab' 트리 파싱 ──────────────────────────────────────────────────────

/** 리스트를 트리(BundleNode[])로 재귀 파싱.
 *  - 중첩 리스트 있는 항목 → 카테고리 노드(label=항목 전체 타이틀,
 *    children=[자기 링크 잎…, 중첩 재귀…]).
 *  - 중첩 없는 항목 → 항목의 각 링크가 형제 잎. 링크 없으면 노드 없음. */
function parseTree(list: PMNode): BundleNode[] {
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
			children.push(...parseTree(nested));
			out.push({ label: title || links[0] || '', link: null, children });
		} else {
			for (const L of links) out.push({ label: L, link: L, children: [] });
		}
	});
	return out;
}

// ── 'bundle' 평탄 엔트리 파싱 ─────────────────────────────────────────────

/** 리스트를 재귀 순회하며 엔트리 수집. category = 상위 항목의 타이틀(없으면 null).
 *  각 항목의 모든 링크를 현재 category 로 push 하고, 중첩 리스트가 있으면
 *  이 항목의 타이틀을 자식들의 category 로 넘긴다. */
function parseListInto(list: PMNode, category: string | null, entries: BundleEntry[]): void {
	list.forEach((li) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		let ownTitle: string | null = null;
		if (para.type.name === 'paragraph') {
			for (const t of collectLinks(para)) entries.push({ title: t, category });
			ownTitle = paragraphText(para) || null;
		}
		// 중첩 리스트(자식) — 이 항목의 타이틀이 자식 카테고리. 빈 타이틀이면
		// 상위 category 를 그대로 물려준다.
		const childCategory = ownTitle ?? category;
		for (let ci = 0; ci < li.childCount; ci++) {
			const child = li.child(ci);
			if (child.type.name === 'bulletList' || child.type.name === 'orderedList') {
				parseListInto(child, childCategory, entries);
			}
		}
	});
}

function parseEntries(list: PMNode): BundleEntry[] {
	const entries: BundleEntry[] = [];
	parseListInto(list, null, entries);
	return entries;
}

export function parseNoteBundles(doc: PMNode): BundleSpec[] {
	const out: BundleSpec[] = [];
	let pending: KeywordInfo | null = null;

	const flush = (list: PMNode | null, listPos: number | null) => {
		if (!pending) return;
		out.push({
			ordinal: out.length,
			kind: pending.kind,
			checkboxPos: pending.checkboxPos,
			checked: pending.checked,
			heightPct: pending.heightPct,
			digitsFrom: pending.digitsFrom,
			digitsTo: pending.digitsTo,
			keywordPos: pending.keywordPos,
			keywordEnd: pending.keywordEnd,
			listPos,
			listEnd: list && listPos !== null ? listPos + list.nodeSize : null,
			tree: list && pending.kind === 'tab' ? parseTree(list) : [],
			entries: list && pending.kind === 'bundle' ? parseEntries(list) : []
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
