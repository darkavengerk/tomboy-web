/**
 * 노트 묶음 파서.
 *
 * `[ ]노트 묶음:N` 키워드 paragraph + 직후 bulletList(내부 링크 항목)를
 * 라이브 PMNode 워크로 찾아 BundleSpec[] 로 반환. 체크박스/라디오는 atom
 * 노드라 plain-JSON 텍스트 스캔으로는 보이지 않는다 — 노드 트리를 걷는다.
 *
 * 순수 함수: IDB/타이틀 인덱스 접근 없음. guid 해석은 NoteBundleStack 이
 * lookupGuidByTitle 로 수행.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface BundleEntry {
	/** tomboyInternalLink mark 의 target (= 대상 노트 제목) */
	title: string;
	/** listItem 첫 paragraph 의 inline 시작 pos — 라디오 자동 삽입 지점 */
	itemTextFrom: number;
	/** inlineRadio atom pos. 없으면 null (자동 삽입 대상) */
	radioPos: number | null;
	selected: boolean;
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
	entries: BundleEntry[];
}

export const DEFAULT_HEIGHT_PCT = 50;

export function clampHeightPct(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_HEIGHT_PCT;
	return Math.min(90, Math.max(20, Math.round(n)));
}

const KEYWORD_RE = /^\s*노트\s*묶음:(\d+)?\s*$/;

interface KeywordInfo {
	checkboxPos: number;
	checked: boolean;
	heightPct: number;
	digitsFrom: number;
	digitsTo: number;
	keywordEnd: number;
}

function parseKeywordParagraph(para: PMNode, paraPos: number): KeywordInfo | null {
	if (para.childCount < 2) return null;
	const first = para.child(0);
	if (first.type.name !== 'inlineCheckbox') return null;
	let text = '';
	for (let i = 1; i < para.childCount; i++) {
		const c = para.child(i);
		if (!c.isText) return null;
		text += c.text ?? '';
	}
	const m = KEYWORD_RE.exec(text);
	if (!m) return null;
	const colonIdx = text.indexOf(':');
	const digitsLen = m[1]?.length ?? 0;
	// 키워드 텍스트 시작 abs pos = paragraph 내용 시작(paraPos+1) + 체크박스 nodeSize 1
	const textBase = paraPos + 2;
	return {
		checkboxPos: paraPos + 1,
		checked: first.attrs.checked === true,
		heightPct: m[1] ? clampHeightPct(parseInt(m[1], 10)) : DEFAULT_HEIGHT_PCT,
		digitsFrom: textBase + colonIdx + 1,
		digitsTo: textBase + colonIdx + 1 + digitsLen,
		keywordEnd: paraPos + para.nodeSize
	};
}

function parseListEntries(list: PMNode, listPos: number): BundleEntry[] {
	const entries: BundleEntry[] = [];
	list.forEach((li, liOff) => {
		if (li.type.name !== 'listItem' || li.childCount === 0) return;
		const para = li.child(0);
		if (para.type.name !== 'paragraph') return;
		const liPos = listPos + 1 + liOff;
		const paraPos = liPos + 1;
		let radioPos: number | null = null;
		let selected = false;
		let title: string | null = null;
		para.forEach((child, childOff) => {
			const abs = paraPos + 1 + childOff;
			if (child.type.name === 'inlineRadio' && radioPos === null) {
				radioPos = abs;
				selected = child.attrs.selected === true;
			} else if (child.isText && title === null) {
				const mark = child.marks.find((mk) => mk.type.name === 'tomboyInternalLink');
				if (mark?.attrs.target) title = String(mark.attrs.target);
			}
		});
		if (title !== null) {
			entries.push({ title, itemTextFrom: paraPos + 1, radioPos, selected });
		}
	});
	return entries;
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
			entries: list && listPos !== null ? parseListEntries(list, listPos) : []
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
