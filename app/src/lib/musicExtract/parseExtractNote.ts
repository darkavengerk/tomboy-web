import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const PREFIX = '음악추출::';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/;
// 재생목록 URL: youtube list= 또는 /playlist? 포함.
const PLAYLIST_URL_RE = /[?&]list=|\/playlist\?/i;
// 생성된 결과 헤더 '플레이리스트:'. inlineCheckbox atom 은 textContent 에 안 나오므로
// 보통 '플레이리스트:'로 시작하지만, atom 미등록(테스트)·수기 입력 대비 선두 [ ]/[x] 허용.
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

/** prose 끝에 붙은 구두점 제거 — 마크 href 가 아닌 텍스트 매칭에만 적용. */
function trimTrailingPunct(url: string): string {
	return url.replace(/[.,;:!?)\]}'"]+$/, '');
}

export type ExtractResult =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string }
	| { kind: 'pending' };

export interface SingleItem {
	kind: 'single';
	source: string;
	result: ExtractResult;
	liPos: number; // top-level listItem 시작 pos (데코 anchor)
}
export interface PlaylistItem {
	kind: 'playlist';
	source: string; // 재생목록 URL
	done: boolean; // 바로 다음 블록이 '플레이리스트:' 결과 헤더이면 true
	paraPos: number; // 소스 문단 시작 pos
}
export type ExtractItem = SingleItem | PlaylistItem;

export interface ExtractNote {
	isExtract: boolean;
	items: ExtractItem[];
}

/** 제목 텍스트가 음악추출 노트 접두사로 시작하는지(싼 게이트). */
export function isExtractTitle(titleText: string): boolean {
	return titleText.trim().startsWith(PREFIX);
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

function nestedListOf(li: PMNode): PMNode | null {
	let found: PMNode | null = null;
	li.forEach((child) => {
		if (!found && isListNode(child)) found = child;
	});
	return found;
}

/** node 안 첫 http URL — tomboyUrlLink/link 마크 href 우선, 없으면 본문 정규식. 링크 텍스트 동반. */
function firstUrlAndText(node: PMNode): { url: string; text: string } | null {
	let out: { url: string; text: string } | null = null;
	node.descendants((n) => {
		if (out) return false;
		if (n.isText) {
			const link = n.marks.find((m) => m.type.name === 'tomboyUrlLink' || m.type.name === 'link');
			const href = link?.attrs?.href;
			if (typeof href === 'string' && HTTP_URL_RE.test(href)) {
				out = { url: href, text: n.text ?? '' };
				return false;
			}
		}
		return true;
	});
	if (out) return out;
	const m = HTTP_URL_RE.exec(node.textContent);
	return m ? { url: trimTrailingPunct(m[0]), text: '' } : null;
}

function headText(li: PMNode): string {
	const first = li.firstChild;
	return first ? first.textContent.trim() : '';
}

/**
 * 항목의 소스 식별자 = head 단락의 링크 href 우선, 없으면 head 텍스트(검색어).
 * 이 값이 (1) yt-dlp 로 보내는 추출 대상이자 (2) writeExtractResult 의 매칭 키다.
 */
export function itemSource(li: PMNode): string {
	const first = li.firstChild;
	if (first) {
		const u = firstUrlAndText(first);
		if (u) return u.url;
	}
	return headText(li);
}

/** 최상위 문단이 재생목록 소스인지 — http URL 이면서 list=/playlist? 포함, /files 결과 아님. */
export function playlistSourceOf(block: PMNode): string | null {
	const u = firstUrlAndText(block);
	if (!u) return null;
	if (RESULT_URL_RE.test(u.url)) return null;
	if (!PLAYLIST_URL_RE.test(u.url)) return null;
	return u.url;
}

/** 텍스트가 생성된 '플레이리스트:' 결과 헤더인지(선두 [ ]/[x] 허용). */
export function isPlaylistHeaderText(text: string): boolean {
	return PLAYLIST_HEADER_RE.test(text.trim());
}

function deriveTitle(url: string, linkText: string): string {
	if (linkText && !HTTP_URL_RE.test(linkText)) return linkText;
	try {
		const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
		return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '') || url;
	} catch {
		return url;
	}
}

export function resultOf(li: PMNode): ExtractResult {
	const nested = nestedListOf(li);
	if (!nested) return { kind: 'pending' };
	let result: ExtractResult = { kind: 'pending' };
	nested.forEach((child) => {
		if (result.kind === 'done') return;
		const u = firstUrlAndText(child);
		if (u && RESULT_URL_RE.test(u.url)) {
			result = { kind: 'done', url: u.url, title: deriveTitle(u.url, u.text) };
			return;
		}
		const txt = child.textContent.trim();
		if (result.kind === 'pending' && txt.startsWith('❌')) {
			result = { kind: 'error', message: txt.replace(/^❌\s*/, '') };
		}
	});
	return result;
}

export function parseExtractNote(doc: PMNode): ExtractNote {
	const title = doc.firstChild?.textContent.trim() ?? '';
	const isExtract = isExtractTitle(title);
	if (!isExtract) return { isExtract, items: [] };
	const items: ExtractItem[] = [];
	let idx = 0;
	let prevPlaylist: PlaylistItem | null = null; // 직전에 본 미완료 재생목록 소스
	let skipNextList = false; // 직전 블록이 결과 헤더 → 다음 리스트는 결과(스킵)
	doc.forEach((block, offset) => {
		const i = idx++;
		// i===0 은 항상 제목 문단(위에서 이미 소비). forEach 가 시작 오프셋을 못 받아 idx 로 스킵.
		if (i === 0) return;
		const type = block.type.name;
		if (type === 'paragraph') {
			const t = block.textContent.trim();
			if (isPlaylistHeaderText(t)) {
				if (prevPlaylist) prevPlaylist.done = true; // 소스의 결과 블록 존재 = 완료
				prevPlaylist = null;
				skipNextList = true;
				return;
			}
			const url = playlistSourceOf(block);
			if (url) {
				const item: PlaylistItem = { kind: 'playlist', source: url, done: false, paraPos: offset };
				items.push(item);
				prevPlaylist = item;
			} else {
				prevPlaylist = null;
			}
			skipNextList = false;
			return;
		}
		if (isListNode(block)) {
			if (skipNextList) {
				skipNextList = false;
				prevPlaylist = null;
				return; // 생성된 결과 리스트
			}
			block.forEach((li, liOffset) => {
				if (li.type.name !== 'listItem') return;
				const source = itemSource(li);
				if (!source || RESULT_URL_RE.test(source)) return; // 결과 mp3 줄은 소스 아님
				items.push({ kind: 'single', source, result: resultOf(li), liPos: offset + 1 + liOffset });
			});
			prevPlaylist = null;
			return;
		}
		prevPlaylist = null;
		skipNextList = false;
	});
	return { isExtract, items };
}

export function pendingItems(note: ExtractNote): ExtractItem[] {
	return note.items.filter((it) => (it.kind === 'single' ? it.result.kind !== 'done' : !it.done));
}

/** 라우트 마운트 게이트용 — JSON doc 첫 단락만 보고 음악추출 노트인지. */
export function isExtractNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(PREFIX);
}
