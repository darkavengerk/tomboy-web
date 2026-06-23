/**
 * 클립보드 충실도 확장 — 붙여넣기 쪽 절반 (복사 쪽 짝: clipboardPlainText.ts).
 *
 * 세 가지를 고친다:
 *
 * 1. **노트→노트 Ctrl+V 원본 보존.** 복사 시 text/html 에 끼워 넣은
 *    `data-tomboy-slice` JSON payload 를 clipboardParser 가 감지해
 *    Slice.fromJSON 으로 정확 복원한다. 커스텀 직렬화(tiptapToHtml)가
 *    떨어뜨리던 각주/체크박스/라디오 atom, 이미지, datetime·size 마크,
 *    빈 paragraph 가 전부 그대로 살아남는다. payload 가 없거나(외부 출처)
 *    깨진 경우(다른 배포 버전 탭의 스키마 드리프트 등)는 조용히 PM 기본
 *    HTML 파싱으로 폴백.
 *
 * 2. **plain 붙여넣기(Ctrl+Shift+V·외부 텍스트)의 빈 줄 보존.** PM 기본
 *    텍스트 파서는 `text.split(/(?:\r\n?|\n)+/)` 로 연속 개행을 collapse
 *    해 빈 줄(= Tomboy 라인 모델의 빈 paragraph)을 날린다. clipboardTextParser
 *    로 한 줄 = paragraph, 빈 줄 = 빈 paragraph 로 대체한다.
 *
 * 3. **붙여넣기의 마크다운 불릿 인식.** `- ` / `* ` / `+ ` 로 시작하는 줄은
 *    타이핑할 때 TipTap input rule 이 불릿 리스트로 바꾸지만, 붙여넣기는
 *    input rule 을 타지 않아 그대로 텍스트(마커 포함)가 됐다. 이건
 *    `transformPasted` 에서 처리한다 — clipboardTextParser(plain 전용)가
 *    아니라 transformPasted 인 이유: 실제 클립보드는 보통 text/html 도 함께
 *    실어 PM 이 DOM 파서(clipboardParser) 경로를 타므로 plain 파서만 고치면
 *    `- ` 가 평문으로 남았다. transformPasted 는 text·html **양쪽 경로**의
 *    최종 Slice 에 모두 적용되므로 출처와 무관하게 동작한다. 연속한 불릿
 *    문단을 묶어 bulletList 로 만들고(들여쓰기 = 중첩) 마커를 떼어낸다.
 *    순서 리스트(`1.`)는 비지원이라 그냥 텍스트로 남는다(아카이버가
 *    직렬화 못 함).
 *
 * 마커 텍스트([^N], [x], ( ) 등)의 atom 재조립도 각 노드의 transformPasted
 * 가 같은 단계에서 수행한다(PM someProp 는 모든 플러그인의 transformPasted 를
 * 순차 적용). 불릿 변환은 첫 텍스트 노드의 선두 마커만 떼므로, 항목 안의
 * [x]·[^N] 마커는 변환 순서와 무관하게 그대로 atom 으로 살아남는다.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
	DOMParser as PMDOMParser,
	Fragment,
	Slice,
	type Node as PMNode,
	type ParseOptions,
	type ResolvedPos,
	type Schema
} from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { TOMBOY_SLICE_ATTR } from './clipboardPlainText.js';

class TomboySliceClipboardParser extends PMDOMParser {
	parseSlice(dom: Node, options?: ParseOptions): Slice {
		const el = (dom as Element).querySelector?.(`[${TOMBOY_SLICE_ATTR}]`);
		const raw = el?.getAttribute(TOMBOY_SLICE_ATTR);
		if (raw) {
			try {
				return Slice.fromJSON(this.schema, JSON.parse(raw));
			} catch {
				// 손상 / 스키마 불일치 — 아래 HTML 파싱 폴백.
			}
		}
		return super.parseSlice(dom, options);
	}
}

/** PM 기본 파서의 rules 를 그대로 물려받는 payload-인식 클립보드 파서. */
export function buildClipboardParser(schema: Schema): PMDOMParser {
	return new TomboySliceClipboardParser(schema, PMDOMParser.fromSchema(schema).rules);
}

/**
 * 빈 줄 보존 plain text 파서. openStart/openEnd 는 PM 이 maxOpen 으로
 * 재정규화하므로 형식적인 값 — 의미는 paragraph 배열 자체에 있다.
 * 불릿 인식은 여기가 아니라 transformPasted 에서 한다(text·html 양쪽 커버).
 */
export function parsePlainTextLines(
	text: string,
	$context: ResolvedPos,
	view: EditorView
): Slice {
	const schema = view.state.schema;
	const marks = $context.marks();
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) =>
			schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined)
		);
	return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}

// ───────────────────────── 마크다운 불릿 변환 ─────────────────────────

/**
 * 문단 선두의 마크다운 불릿 마커(선택 들여쓰기 + `-`/`*`/`+` + 공백 1칸).
 * 타이핑 input rule 과 같은 마커 집합. 마커 뒤 공백 필수 — `-5도` 같은
 * 줄을 불릿으로 오인하지 않는다.
 */
const LEADING_BULLET_RE = /^([ \t]*)[-*+][ \t]/;

interface BulletItem {
	/** 들여쓰기 폭(탭 = 4칸 환산). 중첩 단계 산정용 상대값. */
	indent: number;
	/** 마커 제거 후 남은 인라인 노드들(마크·atom 보존). */
	content: PMNode[];
}

function fragToArray(frag: Fragment): PMNode[] {
	const out: PMNode[] = [];
	frag.forEach((n) => out.push(n));
	return out;
}

/**
 * 인라인 노드 배열의 선두 마커를 떼고 {indent, content} 반환, 아니면 null.
 * 첫 노드가 텍스트이고 그 선두가 마커일 때만 매칭하므로, 이미 다른
 * transformPasted 가 [x] 등을 atom 으로 쪼개 둔 뒤라도 선두 "- " 텍스트는
 * 그대로 남아 안전하게 떼어진다.
 */
function stripLeadingMarker(inline: PMNode[]): BulletItem | null {
	const first = inline[0];
	if (!first || !first.isText || typeof first.text !== 'string') return null;
	const m = LEADING_BULLET_RE.exec(first.text);
	if (!m) return null;
	const indent = m[1].replace(/\t/g, '    ').length;
	const markerLen = m[0].length;
	const content: PMNode[] = [];
	inline.forEach((child, index) => {
		if (index === 0) {
			const rest = child.cut(markerLen); // 마커 이후 텍스트(마크 유지)
			if (rest.text && rest.text.length) content.push(rest);
		} else {
			content.push(child);
		}
	});
	return { indent, content };
}

/** 문단(또는 para 그대로) | 불릿 항목 — transformPasted 중간 표현. */
type Unit = { bullet: BulletItem } | { para: PMNode };

/**
 * 문단을 hardBreak 기준 시각 줄로 쪼개 불릿/문단 unit 배열로. 불릿이 하나도
 * 없으면 null 을 돌려 호출부가 **원본 노드를 그대로** 유지하게 한다(평범한
 * 여러 줄 붙여넣기·마크·attr 손상 방지). 불릿이 있을 때만 줄 단위로 펼친다.
 *
 * 첫 텍스트 노드의 선두 마커만 보므로, 이미 다른 transformPasted 가 [x] 등을
 * atom 으로 쪼개 둔 뒤라도 안전하게 동작한다. `<br>` 로 줄을 나누는 출처
 * (contenteditable 등)와 `<p>`/`<div>` 로 나누는 출처를 모두 커버.
 */
function splitParagraphUnits(node: PMNode, schema: Schema): Unit[] | null {
	const { paragraph, hardBreak } = schema.nodes;
	if (node.type !== paragraph) return null;

	const segments: PMNode[][] = [[]];
	node.content.forEach((child) => {
		if (hardBreak && child.type === hardBreak) segments.push([]);
		else segments[segments.length - 1].push(child);
	});
	// 끝의 빈 줄(꼬리 hardBreak)은 버린다 — 불릿 뒤 군더더기 빈 문단 방지.
	while (segments.length > 1 && segments[segments.length - 1].length === 0) segments.pop();

	const units: Unit[] = [];
	let anyBullet = false;
	for (const seg of segments) {
		const item = stripLeadingMarker(seg);
		if (item) {
			units.push({ bullet: item });
			anyBullet = true;
		} else {
			units.push({
				para: paragraph.create(null, seg.length ? Fragment.fromArray(seg) : undefined)
			});
		}
	}
	return anyBullet ? units : null;
}

interface BulletTreeNode extends BulletItem {
	children: BulletTreeNode[];
}

/** 들여쓰기 폭으로 불릿 항목을 중첩 forest 로 — 스택 기반(상대 깊이). */
function buildBulletForest(items: BulletItem[]): BulletTreeNode[] {
	const roots: BulletTreeNode[] = [];
	const stack: BulletTreeNode[] = [];
	for (const item of items) {
		const node: BulletTreeNode = { ...item, children: [] };
		while (stack.length && stack[stack.length - 1].indent >= item.indent) stack.pop();
		if (stack.length === 0) roots.push(node);
		else stack[stack.length - 1].children.push(node);
		stack.push(node);
	}
	return roots;
}

function makeListItem(node: BulletTreeNode, schema: Schema): PMNode {
	const { listItem, paragraph, bulletList } = schema.nodes;
	const children: PMNode[] = [paragraph.create(null, node.content)];
	if (node.children.length) {
		children.push(
			bulletList.create(null, node.children.map((c) => makeListItem(c, schema)))
		);
	}
	return listItem.create(null, children);
}

function makeBulletList(roots: BulletTreeNode[], schema: Schema): PMNode {
	return schema.nodes.bulletList.create(null, roots.map((r) => makeListItem(r, schema)));
}

/**
 * 이미 진짜 리스트로 들어온 Slice(예: 외부 `<ul><li>- 사과</li></ul>` HTML)
 * 의 각 listItem 첫 문단에서 선두 마커를 떼어낸다. 중첩 리스트까지 재귀.
 * 변경이 없으면 같은 Fragment 를 그대로 돌려준다.
 *
 * 이게 없으면: 마크다운을 리스트로 렌더하면서 항목 텍스트에 `- ` 를 남기는
 * 출처에서 "리스트는 만들어지는데 - 가 그대로 남는" 증상이 난다.
 */
function stripExistingListMarkers(frag: Fragment, schema: Schema): Fragment {
	const { bulletList, listItem, paragraph } = schema.nodes;
	if (!bulletList || !listItem || !paragraph) return frag;

	let changed = false;
	const out = fragToArray(frag).map((node) => {
		if (node.type !== bulletList) return node;
		let listChanged = false;
		const items = fragToArray(node.content).map((li) => {
			if (li.type !== listItem) return li;
			const liChildren = fragToArray(li.content);
			let liChanged = false;
			// 첫 문단 선두 마커 제거.
			const head = liChildren[0];
			if (head && head.type === paragraph) {
				const stripped = stripLeadingMarker(fragToArray(head.content));
				if (stripped) {
					liChildren[0] = paragraph.create(
						head.attrs,
						stripped.content.length ? Fragment.fromArray(stripped.content) : undefined
					);
					liChanged = true;
				}
			}
			// 중첩 리스트 재귀.
			for (let k = 1; k < liChildren.length; k++) {
				const child = liChildren[k];
				if (child.type === bulletList) {
					const recNode = fragToArray(stripExistingListMarkers(Fragment.from(child), schema))[0];
					if (recNode && recNode !== child) {
						liChildren[k] = recNode;
						liChanged = true;
					}
				}
			}
			if (!liChanged) return li;
			listChanged = true;
			return listItem.create(li.attrs, Fragment.fromArray(liChildren));
		});
		if (!listChanged) return node;
		changed = true;
		return bulletList.create(node.attrs, Fragment.fromArray(items));
	});
	return changed ? Fragment.fromArray(out) : frag;
}

/**
 * 붙여넣기 Slice 의 마크다운 불릿 정리. 두 경로를 모두 커버:
 *  A) 이미 진짜 리스트인데 항목 텍스트에 `- ` 가 남은 경우 → 마커 제거.
 *  B) `- ` 로 시작하는 평문 문단/줄 → bulletList 로 묶기(들여쓰기 = 중첩).
 * 변환이 없으면 원본 Slice 를 그대로 돌려준다(객체 동일성 유지).
 */
export function transformPastedBullets(slice: Slice, schema: Schema): Slice {
	const { bulletList, paragraph } = schema.nodes;
	if (!bulletList || !paragraph) return slice; // 스키마에 불릿 없음 — no-op

	// A) 기존 리스트 항목의 선두 마커 제거.
	const stripped = stripExistingListMarkers(slice.content, schema);
	const strippedChanged = stripped !== slice.content;

	// B) 최상위 문단을 시각 줄 단위 unit 으로 펼친다(불릿 있는 문단만).
	const units: Unit[] = [];
	let grouped = false;
	stripped.forEach((node) => {
		const split = splitParagraphUnits(node, schema);
		if (split) {
			units.push(...split);
			grouped = true;
		} else {
			units.push({ para: node });
		}
	});

	if (!strippedChanged && !grouped) return slice;
	if (!grouped) {
		// A 만 적용 — 구조는 그대로, open 깊이 유지.
		return new Slice(stripped, slice.openStart, slice.openEnd);
	}

	// 연속한 불릿 unit 을 bulletList 하나로 묶는다(들여쓰기 = 중첩).
	const out: PMNode[] = [];
	let i = 0;
	while (i < units.length) {
		const u = units[i];
		if ('bullet' in u) {
			const run: BulletItem[] = [];
			let cur: Unit;
			while (i < units.length && 'bullet' in (cur = units[i])) {
				run.push(cur.bullet);
				i++;
			}
			out.push(makeBulletList(buildBulletForest(run), schema));
		} else {
			out.push(u.para);
			i++;
		}
	}

	// 가장자리가 리스트로 바뀌었으면 닫힘(0) — 리스트는 통째 블록으로 삽입.
	// 그대로 문단이면 원래 open 깊이 유지(현재 줄로 텍스트 병합).
	const openStart = out[0]?.type === bulletList ? 0 : slice.openStart;
	const openEnd = out[out.length - 1]?.type === bulletList ? 0 : slice.openEnd;
	return new Slice(Fragment.fromArray(out), openStart, openEnd);
}

export const ClipboardFidelity = Extension.create({
	name: 'tomboyClipboardFidelity',

	addProseMirrorPlugins() {
		const parser = buildClipboardParser(this.editor.schema);
		return [
			new Plugin({
				key: new PluginKey('tomboyClipboardFidelity'),
				props: {
					clipboardParser: parser,
					clipboardTextParser: (text, $context, _plainText, view) =>
						parsePlainTextLines(text, $context, view),
					transformPasted: (slice, view) =>
						transformPastedBullets(slice, view.state.schema)
				}
			})
		];
	}
});
