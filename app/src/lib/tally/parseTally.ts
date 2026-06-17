/**
 * 집계 노트 파서 — `parseDedicatedBundle`(noteBundle/parser.ts) 의 쌍둥이.
 *
 * 제목 `집계::<제목>` 을 시그니처로, 본문(JSONContent)을 문제 목록으로 읽는다.
 * 문제 = 단락(설정 토큰 포함) + 직후 bulletList(보기). 순수 함수 — IDB/인덱스
 * 접근 없음.
 */
import type { JSONContent } from '@tiptap/core';
import type { TallySpec, TallyQuestion } from './types.js';

const TALLY_PREFIX = '집계::';

interface JSONNode {
	type?: string;
	text?: string;
	content?: JSONNode[];
}

/** 제목이 집계 노트 시그니처면 true. */
export function isTallyTitle(title: string): boolean {
	return (title ?? '').trimStart().startsWith(TALLY_PREFIX);
}

/** `집계::` 접두를 뗀 투표 제목. */
export function tallyName(title: string): string {
	const t = (title ?? '').trimStart();
	return t.startsWith(TALLY_PREFIX) ? t.slice(TALLY_PREFIX.length).trim() : t.trim();
}

function isListJson(n: JSONNode): boolean {
	return n.type === 'bulletList' || n.type === 'orderedList';
}

function isTextblockJson(n: JSONNode): boolean {
	return n.type === 'paragraph' || n.type === 'heading';
}

/** 단락의 텍스트 노드만 이어붙임(트림은 호출부에서). */
function textOf(node: JSONNode): string {
	let s = '';
	for (const c of node.content ?? []) {
		if (c.type === 'text') s += c.text ?? '';
		else if (c.content) s += textOf(c);
	}
	return s;
}

/** listItem 의 첫 textblock 텍스트 = 보기 라벨. */
function optionLabel(li: JSONNode): string {
	const para = (li.content ?? []).find((c) => isTextblockJson(c));
	return para ? textOf(para).trim() : '';
}

/** bulletList → 보기 라벨 배열(빈 항목 제외). */
function parseOptions(list: JSONNode): string[] {
	const out: string[] = [];
	for (const li of list.content ?? []) {
		if (li.type !== 'listItem') continue;
		const label = optionLabel(li);
		if (label) out.push(label);
	}
	return out;
}

/**
 * 단락 텍스트에서 설정 토큰을 분리.
 * `질문 |중복가능|정답:3` → { text:'질문', allowMultiple:true, correctIndex:2 }
 * 첫 `|` 앞은 본문, 이후 각 세그먼트는 토큰.
 */
function parseSettings(raw: string): {
	text: string;
	allowMultiple: boolean;
	correctIndex: number | null;
} {
	const segs = raw.split('|');
	const text = (segs[0] ?? '').trim();
	let allowMultiple = false;
	let correctIndex: number | null = null;
	for (let i = 1; i < segs.length; i++) {
		const tok = segs[i].trim();
		if (tok === '중복가능') {
			allowMultiple = true;
			continue;
		}
		const m = /^정답\s*:\s*(\d+)$/.exec(tok);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n >= 1) correctIndex = n - 1; // 1-based → 0-based
		}
	}
	return { text, allowMultiple, correctIndex };
}

/** 제목 라인(블록 0)을 뺀 최상위 블록들. */
function bodyBlocks(doc: JSONNode): JSONNode[] {
	return (doc.content ?? []).slice(1);
}

/**
 * 본문 JSONContent → TallySpec. 단락 + 직후 리스트 쌍을 문제로 모은다.
 * 리스트가 따라오지 않는 단락은 무시(보기 없는 문제는 문제가 아님).
 * correctIndex 는 보기 범위를 벗어나면 무효화(파싱 단계에서 클램프).
 */
export function parseTallyNote(doc: JSONContent, title: string): TallySpec {
	const root = doc as JSONNode;
	const blocks = bodyBlocks(root);
	const questions: TallyQuestion[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const node = blocks[i];
		if (!isTextblockJson(node)) continue;
		const next = blocks[i + 1];
		if (!next || !isListJson(next)) continue;
		const options = parseOptions(next);
		i++; // 리스트 소비
		if (options.length === 0) continue;
		const { text, allowMultiple, correctIndex: rawCorrect } = parseSettings(textOf(node));
		const correctIndex =
			rawCorrect !== null && rawCorrect >= 0 && rawCorrect < options.length ? rawCorrect : null;
		questions.push({
			index: questions.length,
			text,
			options,
			allowMultiple,
			correctIndex
		});
	}
	return { title: tallyName(title), questions };
}
