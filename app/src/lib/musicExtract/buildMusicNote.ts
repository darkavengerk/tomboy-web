import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';
import { playlistSourceOf, isPlaylistHeaderText, firstUrlAndText } from './parseExtractNote.js';

const MUSIC_PREFIX = '음악::';
// 헤더 텍스트에서 라벨만 추출 — 선두 [ ]/[x](폴백 텍스트) + '플레이리스트:' 접두 제거.
const HEADER_LABEL_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:\s*/;

/** 재생목록 라벨 → 음악 노트 제목. */
export function musicNoteTitleFor(label: string): string {
	return `${MUSIC_PREFIX}${label}`;
}

interface Block {
	node: PMNode;
	offset: number;
}

function topBlocks(doc: PMNode): Block[] {
	const out: Block[] = [];
	doc.forEach((node, offset) => out.push({ node, offset }));
	return out;
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

/**
 * 완료 재생목록 = 소스 문단 + (바로 다음) '플레이리스트:' 결과 헤더 문단의 쌍.
 * 헤더 다음 리스트 블록(있으면)을 셋째 인자로 함께 넘긴다(트랙 출처).
 */
function eachDonePlaylist(
	doc: PMNode,
	cb: (source: string, header: Block, list: PMNode | undefined) => void
): void {
	const blocks = topBlocks(doc);
	for (let i = 1; i < blocks.length; i++) {
		const source = playlistSourceOf(blocks[i].node);
		if (!source) continue;
		const header = blocks[i + 1];
		if (!header || header.node.type.name !== 'paragraph') continue;
		if (!isPlaylistHeaderText(header.node.textContent)) continue;
		const next = blocks[i + 2]?.node;
		cb(source, header, next && isListNode(next) ? next : undefined);
	}
}

/** 완료 재생목록마다 '노트 만들기' 위젯 anchor(헤더 문단 inline 끝 pos) + source. */
export function donePlaylistAnchors(doc: PMNode): { source: string; pos: number }[] {
	const out: { source: string; pos: number }[] = [];
	eachDonePlaylist(doc, (source, header) => {
		// 문단 inline 콘텐츠 끝 = offset + nodeSize - 1 (닫는 토큰 직전). side:1 위젯이
		// 헤더 텍스트 바로 뒤에 붙는다.
		out.push({ source, pos: header.offset + header.node.nodeSize - 1 });
	});
	return out;
}

function labelFromHeader(text: string): string {
	return text.replace(HEADER_LABEL_RE, '').trim();
}

function urlsFromList(list: PMNode | undefined): string[] {
	if (!list) return [];
	const urls: string[] = [];
	list.forEach((li) => {
		if (li.type.name !== 'listItem') return;
		const u = firstUrlAndText(li);
		if (u) urls.push(u.url);
	});
	return urls;
}

/** source(재생목록 URL)에 대응하는 완료 결과의 label + 트랙 URL 목록. 미완료/트랙없음 → null. */
export function readPlaylistResult(
	doc: PMNode,
	source: string
): { label: string; urls: string[] } | null {
	let found: { label: string; urls: string[] } | null = null;
	eachDonePlaylist(doc, (src, header, list) => {
		if (found || src !== source) return;
		const urls = urlsFromList(list);
		if (urls.length === 0) return;
		found = { label: labelFromHeader(header.node.textContent), urls };
	});
	return found;
}

// 결과 링크는 text===href(urlChild 패턴) — .note(<link:url>)가 텍스트만 보존하고 href 를
// textContent 에서 복원하므로, 드롭박스 동기/리로드 후에도 URL 이 살아남는다.
function urlText(url: string): JSONContent {
	return { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] };
}

/**
 * 음악:: 노트 본문 doc — 제목 문단 + 체크된 '플레이리스트:' 헤더(inlineCheckbox atom) + mp3 불릿.
 * writePlaylistBlock 이 음악추출 노트에 쓰는 블록과 동일 구조(checked=true → 큐 활성).
 */
export function buildMusicNoteDoc(title: string, label: string, urls: string[]): JSONContent {
	return {
		type: 'doc',
		content: [
			{ type: 'paragraph', content: [{ type: 'text', text: title }] },
			{
				type: 'paragraph',
				content: [
					{ type: 'inlineCheckbox', attrs: { checked: true } },
					{ type: 'text', text: `플레이리스트: ${label}` }
				]
			},
			{
				type: 'bulletList',
				content: urls.map((u) => ({
					type: 'listItem',
					content: [{ type: 'paragraph', content: [urlText(u)] }]
				}))
			}
		]
	};
}
