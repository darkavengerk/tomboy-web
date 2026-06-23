/**
 * 클립보드 충실도 확장 — 붙여넣기 쪽 절반 (복사 쪽 짝: clipboardPlainText.ts).
 *
 * 두 가지를 고친다:
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
 * 3. **plain 붙여넣기의 마크다운 불릿 인식.** `- ` / `* ` / `+ ` 로 시작하는
 *    줄은 타이핑할 때 TipTap input rule 이 불릿 리스트로 바꾸지만, 붙여넣기는
 *    input rule 을 타지 않아 그대로 텍스트가 됐다. 연속한 불릿 줄을 묶어
 *    bulletList 로 만든다(들여쓰기 = 중첩). 순서 리스트(`1.`)는 비지원이라
 *    그냥 일반 텍스트 줄로 남는다(아카이버가 직렬화 못 함).
 *
 * 마커 텍스트([^N], [x], ( ) 등)의 atom 재조립은 각 노드의 transformPasted
 * 가 parseFromClipboard 마지막 단계에서 이 뒤에 그대로 수행한다 — 불릿
 * 항목 안 텍스트에도 동일하게 적용된다.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import {
	DOMParser as PMDOMParser,
	Fragment,
	Slice,
	type Mark,
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
 * 마크다운 불릿 줄(`- ` / `* ` / `+ ` + 선택 들여쓰기) 매칭.
 * 타이핑 input rule 과 같은 마커 집합. 마커 뒤 공백 1칸은 필수 —
 * `-5도` 같은 줄을 불릿으로 오인하지 않는다.
 */
const BULLET_RE = /^([ \t]*)[-*+][ \t](.*)$/;

interface BulletLine {
	/** 들여쓰기 폭(탭 = 4칸 환산). 중첩 단계 산정에만 쓰는 상대값. */
	indent: number;
	/** 마커·들여쓰기 제거 후 본문. */
	content: string;
}

function matchBullet(line: string): BulletLine | null {
	const m = BULLET_RE.exec(line);
	if (!m) return null;
	const indent = m[1].replace(/\t/g, '    ').length;
	return { indent, content: m[2] };
}

interface BulletTreeNode {
	content: string;
	children: BulletTreeNode[];
}

/** 들여쓰기 폭으로 불릿 줄을 중첩 forest 로 — 스택 기반(상대 깊이). */
function buildBulletForest(lines: BulletLine[]): BulletTreeNode[] {
	const roots: BulletTreeNode[] = [];
	const stack: { indent: number; node: BulletTreeNode }[] = [];
	for (const line of lines) {
		const node: BulletTreeNode = { content: line.content, children: [] };
		while (stack.length && stack[stack.length - 1].indent >= line.indent) stack.pop();
		if (stack.length === 0) roots.push(node);
		else stack[stack.length - 1].node.children.push(node);
		stack.push({ indent: line.indent, node });
	}
	return roots;
}

function makeListItem(node: BulletTreeNode, schema: Schema, marks: readonly Mark[]): PMNode {
	const { listItem, paragraph, bulletList } = schema.nodes;
	const para = paragraph.create(
		null,
		node.content ? schema.text(node.content, marks) : undefined
	);
	const children: PMNode[] = [para];
	if (node.children.length) {
		children.push(
			bulletList.create(null, node.children.map((c) => makeListItem(c, schema, marks)))
		);
	}
	return listItem.create(null, children);
}

function makeBulletList(roots: BulletTreeNode[], schema: Schema, marks: readonly Mark[]): PMNode {
	return schema.nodes.bulletList.create(
		null,
		roots.map((r) => makeListItem(r, schema, marks))
	);
}

/**
 * 빈 줄 보존 + 마크다운 불릿 인식 plain text 파서. openStart/openEnd 는
 * 가장자리 블록이 paragraph 일 때만 1(현재 줄로 텍스트 병합), 리스트면 0
 * (블록 통째 삽입).
 */
export function parsePlainTextLines(
	text: string,
	$context: ResolvedPos,
	view: EditorView
): Slice {
	const schema = view.state.schema;
	const marks = $context.marks();
	const lines = text.replace(/\r\n?/g, '\n').split('\n');

	const blocks: PMNode[] = [];
	let i = 0;
	while (i < lines.length) {
		if (matchBullet(lines[i])) {
			const run: BulletLine[] = [];
			let b: BulletLine | null;
			while (i < lines.length && (b = matchBullet(lines[i]))) {
				run.push(b);
				i++;
			}
			blocks.push(makeBulletList(buildBulletForest(run), schema, marks));
		} else {
			const line = lines[i];
			blocks.push(
				schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : undefined)
			);
			i++;
		}
	}

	const openStart = blocks[0]?.type === schema.nodes.paragraph ? 1 : 0;
	const last = blocks[blocks.length - 1];
	const openEnd = last?.type === schema.nodes.paragraph ? 1 : 0;
	return new Slice(Fragment.fromArray(blocks), openStart, openEnd);
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
						parsePlainTextLines(text, $context, view)
				}
			})
		];
	}
});
