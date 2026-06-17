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
import type { JSONContent } from '@tiptap/core';

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
	/** 0=타이틀만(묶음 전용), 100=노트 끝까지 확장(fit), 그 외 20–90. 생략 시 50 */
	heightPct: number;
	/** 묶음 표시 바 개수(윈도우 폭). 1–100, 100=전부+타이틀만. 생략 시 5. 탭은 무시 */
	maxCount: number;
	/** 첫 `:` 뒤 높이 숫자 텍스트 범위 — 높이 쓰기백 대상(개수 숫자는 건드리지 않음). 숫자 없으면 from===to */
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
export const DEFAULT_MAX_COUNT = 5;

export function clampHeightPct(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_HEIGHT_PCT;
	const r = Math.round(n);
	if (r <= 0) return 0; // 타이틀만(묶음 전용)
	if (r >= 100) return 100; // 노트 끝까지 확장(fit)
	return Math.min(90, Math.max(20, r));
}

/** 묶음 표시 개수(윈도우 폭) 클램프 — 1–100(100=전부). 생략/NaN → 기본 5. */
export function clampMaxCount(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_MAX_COUNT;
	return Math.min(100, Math.max(1, Math.round(n)));
}

// `탭:N[:M]` / `묶음:N[:M]` (옛 `노트 ` 접두 허용). N=높이%, M=표시 개수(묶음 전용).
// `묶음::100`(N 생략 + M=100)도 매칭 — 빈 높이 + 개수 100.
const TAB_RE = /^\s*(?:노트\s*)?탭:(\d+)?(?::(\d+))?\s*$/;
const BUNDLE_RE = /^\s*(?:노트\s*)?묶음:(\d+)?(?::(\d+))?\s*$/;

interface KeywordInfo {
	kind: BundleKind;
	checkboxPos: number;
	checked: boolean;
	heightPct: number;
	maxCount: number;
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
		maxCount: m[2] ? clampMaxCount(parseInt(m[2], 10)) : DEFAULT_MAX_COUNT,
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
 *  - 중첩 리스트 있는 항목 → 순수 카테고리 노드(label=항목 전체 타이틀,
 *    children=중첩 재귀만). 자기 링크는 무시한다(의도치 않은 링크 방지).
 *  - 중첩 없는 항목 → 항목의 각 링크가 형제 잎. 링크 없으면 노드 없음. */
function parseTree(list: PMNode): BundleNode[] {
	const out: BundleNode[] = [];
	list.forEach((li) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		const isPara = para.type.name === 'paragraph';
		let nested: PMNode | null = null;
		for (let ci = 0; ci < li.childCount; ci++) {
			const c = li.child(ci);
			if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
				nested = c;
				break;
			}
		}
		if (nested) {
			// 자식 있음 → 순수 카테고리. 자기 링크는 버린다.
			out.push({ label: isPara ? paragraphText(para) : '', link: null, children: parseTree(nested) });
		} else if (isPara) {
			for (const L of collectLinks(para)) out.push({ label: L, link: L, children: [] });
		}
	});
	return out;
}

// ── 'bundle' 평탄 엔트리 파싱 ─────────────────────────────────────────────

/** 리스트를 재귀 순회하며 엔트리 수집. category = 상위 항목의 타이틀(없으면 null).
 *  자식(중첩 리스트) 없는 항목만 자기 링크를 엔트리로 push. 자식 있는 항목은
 *  순수 카테고리 — 자기 링크는 무시하고 타이틀만 자식 category 로 넘긴다. */
function parseListInto(list: PMNode, category: string | null, entries: BundleEntry[]): void {
	list.forEach((li) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		const isPara = para.type.name === 'paragraph';
		const ownTitle = isPara ? paragraphText(para) || null : null;
		let hasNested = false;
		for (let ci = 0; ci < li.childCount; ci++) {
			const c = li.child(ci);
			if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
				hasNested = true;
				break;
			}
		}
		if (hasNested) {
			// 순수 카테고리 — 자기 링크 무시, 타이틀(빈 타이틀이면 상위)을 자식 category 로.
			const childCategory = ownTitle ?? category;
			for (let ci = 0; ci < li.childCount; ci++) {
				const c = li.child(ci);
				if (c.type.name === 'bulletList' || c.type.name === 'orderedList') {
					parseListInto(c, childCategory, entries);
				}
			}
		} else if (isPara) {
			for (const t of collectLinks(para)) entries.push({ title: t, category });
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
			maxCount: pending.maxCount,
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

// ─────────────────────────────────────────────────────────────────────────
//  전용 노트 (dedicated note) — 제목이 `탭::` / `묶음::` 로 시작하는 노트는
//  본문 전체가 곧 파일철. 인-에디터 위젯이 아니라 note 라우트/NoteWindow 가
//  풀-노트 뷰로 띄운다(터미널/음악 노트 패턴).
//
//  소스가 라이브 PMNode 가 아니라 editorContent(JSONContent)라 위의 PMNode
//  파서를 재사용하지 못한다 — 같은 규칙을 JSON 트리에 대해 다시 구현한다.
//
//  깊이 모델: 본문이 곧 "깊이1 리스트". 본문 최상위 단락 = 깊이1 항목.
//  단락 바로 뒤에 리스트가 오면 그 단락이 부모(카테고리), 리스트 항목은
//  깊이2 — 옛 "listItem + 중첩 bulletList" 관계를 한 단계 위로 옮긴 것.
//  부모 단락 없이 시작하는 리스트는 항목이 깊이1로 직접 들어간다(폴백).
// ─────────────────────────────────────────────────────────────────────────

interface JSONNode {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
	content?: JSONNode[];
}

/** 제목이 전용 파일철 시그니처면 kind, 아니면 null. */
export function dedicatedBundleKind(title: string): BundleKind | null {
	const t = (title ?? '').trimStart();
	if (t.startsWith('탭::')) return 'tab';
	if (t.startsWith('묶음::')) return 'bundle';
	return null;
}

function isListJson(n: JSONNode): boolean {
	return n.type === 'bulletList' || n.type === 'orderedList';
}

function isTextblockJson(n: JSONNode): boolean {
	return n.type === 'paragraph' || n.type === 'heading';
}

/** JSON 단락의 내부 링크 target 들을 등장 순서대로(인접 중복 1개로) 수집. */
function collectLinksJson(para: JSONNode): string[] {
	const out: string[] = [];
	let lastTarget: string | null = null;
	for (const child of para.content ?? []) {
		if (child.type !== 'text') {
			lastTarget = null;
			continue;
		}
		const mark = (child.marks ?? []).find((m) => m.type === 'tomboyInternalLink');
		const target = mark?.attrs?.target ? String(mark.attrs.target) : null;
		if (target && target !== lastTarget) out.push(target);
		lastTarget = target;
	}
	return out;
}

/** JSON 단락의 텍스트만 이어붙여 trim — 카테고리 라벨용. */
function paragraphTextJson(para: JSONNode): string {
	let s = '';
	for (const c of para.content ?? []) if (c.type === 'text') s += c.text ?? '';
	return s.trim();
}

/** 리스트(JSON)를 'tab' 트리로 재귀 파싱 — parseTree 의 JSON 판. */
function parseTreeJson(list: JSONNode): BundleNode[] {
	const out: BundleNode[] = [];
	for (const li of list.content ?? []) {
		if (li.type !== 'listItem' || !li.content?.length) continue;
		const para = li.content[0];
		const isPara = isTextblockJson(para);
		let nested: JSONNode | null = null;
		for (const c of li.content) {
			if (isListJson(c)) {
				nested = c;
				break;
			}
		}
		if (nested) {
			// 자식 있음 → 순수 카테고리. 자기 링크는 버린다.
			out.push({ label: isPara ? paragraphTextJson(para) : '', link: null, children: parseTreeJson(nested) });
		} else if (isPara) {
			for (const L of collectLinksJson(para)) out.push({ label: L, link: L, children: [] });
		}
	}
	return out;
}

/** 리스트(JSON)를 'bundle' 평탄 엔트리로 — parseListInto 의 JSON 판. */
function parseListIntoJson(list: JSONNode, category: string | null, entries: BundleEntry[]): void {
	for (const li of list.content ?? []) {
		if (li.type !== 'listItem' || !li.content?.length) continue;
		const para = li.content[0];
		const isPara = isTextblockJson(para);
		const ownTitle = isPara ? paragraphTextJson(para) || null : null;
		const hasNested = (li.content ?? []).some((c) => isListJson(c));
		if (hasNested) {
			// 순수 카테고리 — 자기 링크 무시, 타이틀을 자식 category 로.
			const childCategory = ownTitle ?? category;
			for (const c of li.content) {
				if (isListJson(c)) parseListIntoJson(c, childCategory, entries);
			}
		} else if (isPara) {
			for (const t of collectLinksJson(para)) entries.push({ title: t, category });
		}
	}
}

/** 제목 라인(블록 0) — 옵션 라인 소비 시 추가로 블록 1 — 을 제외한 본문 블록들.
 *  start: 링크 목록이 시작하는 블록 인덱스(옵션 없으면 1, 옵션 라인 있으면 2). */
function bodyBlocks(doc: JSONNode, start = 1): JSONNode[] {
	return (doc.content ?? []).slice(start);
}

// 전용 노트 옵션 라인 — 본문 2번째 줄(제목 다음 첫 블록)이 `:높이[:개수]` 면
// 파일철 옵션으로 소비(링크 목록에서 제외). 인라인 `묶음:N:M` 과 같은 의미:
// N=높이%(전용 뷰는 컨테이너를 채우므로 0=타이틀만 외엔 사실상 무의미),
// M=표시 바 개수(윈도우 폭, 기본 5, 100=전부). 선행 `:` + 숫자 한 그룹 이상
// 일 때만 매칭 — 일반 첫 줄/링크를 잘못 먹지 않는다. 높이 생략(`::개수`)은
// 전용 기본 100 유지.
const DEDICATED_OPTS_RE = /^\s*:(\d+)?(?::(\d+))?\s*$/;

interface DedicatedOpts {
	heightPct: number;
	maxCount: number;
	/** 링크 목록이 시작하는 본문 블록 인덱스 — 옵션 라인 소비 시 2, 아니면 1. */
	bodyStart: number;
}

function parseDedicatedOptions(root: JSONNode): DedicatedOpts {
	const opt = (root.content ?? [])[1];
	if (opt && isTextblockJson(opt)) {
		const m = DEDICATED_OPTS_RE.exec(paragraphTextJson(opt));
		if (m && (m[1] || m[2])) {
			return {
				heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : 100,
				maxCount: m[2] ? clampMaxCount(parseInt(m[2], 10)) : DEFAULT_MAX_COUNT,
				bodyStart: 2
			};
		}
	}
	return { heightPct: 100, maxCount: DEFAULT_MAX_COUNT, bodyStart: 1 };
}

function parseDedicatedTree(doc: JSONNode, start = 1): BundleNode[] {
	const out: BundleNode[] = [];
	const blocks = bodyBlocks(doc, start);
	for (let i = 0; i < blocks.length; i++) {
		const node = blocks[i];
		if (isTextblockJson(node)) {
			const next = blocks[i + 1];
			if (next && isListJson(next)) {
				// 단락 = 순수 카테고리, 다음 리스트 = 자식(깊이2). 자기 링크는 버린다.
				out.push({ label: paragraphTextJson(node), link: null, children: parseTreeJson(next) });
				i++; // 리스트 소비
			} else {
				for (const L of collectLinksJson(node)) out.push({ label: L, link: L, children: [] });
			}
		} else if (isListJson(node)) {
			// 부모 단락 없는 리스트 → 항목들이 깊이1로 직접
			out.push(...parseTreeJson(node));
		}
	}
	return out;
}

function parseDedicatedEntries(doc: JSONNode, start = 1): BundleEntry[] {
	const entries: BundleEntry[] = [];
	const blocks = bodyBlocks(doc, start);
	for (let i = 0; i < blocks.length; i++) {
		const node = blocks[i];
		if (isTextblockJson(node)) {
			const next = blocks[i + 1];
			if (next && isListJson(next)) {
				// 단락 = 순수 카테고리 — 자기 링크 무시, 타이틀만 자식 category 로.
				parseListIntoJson(next, paragraphTextJson(node) || null, entries);
				i++; // 리스트 소비
			} else {
				for (const t of collectLinksJson(node)) entries.push({ title: t, category: null });
			}
		} else if (isListJson(node)) {
			parseListIntoJson(node, null, entries);
		}
	}
	return entries;
}

/** 전용 노트 본문(JSONContent)을 합성 BundleSpec 으로. 인-에디터 쓰기백
 *  필드(checkboxPos/digits/keyword/list pos)는 의미 없어 -1/null, checked=true.
 *  heightPct/maxCount 는 본문 2번째 줄 옵션 라인(`:높이:개수`)에서 — 없으면
 *  heightPct=100(컨테이너를 꽉 채움)·maxCount=5(윈도우 폭). 옵션 라인은 링크
 *  목록에서 제외된다(bodyStart). */
export function parseDedicatedBundle(doc: JSONContent, kind: BundleKind): BundleSpec {
	const root = doc as JSONNode;
	const opts = parseDedicatedOptions(root);
	return {
		ordinal: 0,
		kind,
		checkboxPos: -1,
		checked: true,
		heightPct: opts.heightPct,
		maxCount: opts.maxCount,
		digitsFrom: -1,
		digitsTo: -1,
		keywordPos: -1,
		keywordEnd: -1,
		listPos: null,
		listEnd: null,
		tree: kind === 'tab' ? parseDedicatedTree(root, opts.bodyStart) : [],
		entries: kind === 'bundle' ? parseDedicatedEntries(root, opts.bodyStart) : []
	};
}

/** 임시(합성) 파일철 — 노트 제목 리스트를 평탄 BundleSpec 으로. 역참조 등
 *  실제 노트/리스트가 아닌 동적 목록을 띄울 때 쓴다. 전용 노트와 같은 합성
 *  필드 규약(checkboxPos/digits/keyword/list = -1/null, checked=true,
 *  heightPct=100). IDB/타이틀 인덱스를 건드리지 않는다 — guid 해석은 컴포넌트가
 *  lookupGuidByTitle 로 수행. */
export function buildSyntheticBundleSpec(titles: string[], kind: BundleKind): BundleSpec {
	const clean = titles.map((t) => (t ?? '').trim()).filter(Boolean);
	return {
		ordinal: 0,
		kind,
		checkboxPos: -1,
		checked: true,
		heightPct: 100,
		maxCount: DEFAULT_MAX_COUNT,
		digitsFrom: -1,
		digitsTo: -1,
		keywordPos: -1,
		keywordEnd: -1,
		listPos: null,
		listEnd: null,
		tree: kind === 'tab' ? clean.map((t) => ({ label: t, link: t, children: [] })) : [],
		entries: kind === 'bundle' ? clean.map((t) => ({ title: t, category: null })) : []
	};
}
