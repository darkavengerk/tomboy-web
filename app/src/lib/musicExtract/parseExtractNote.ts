import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const PREFIX = '음악추출::';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/;

/** prose 끝에 붙은 구두점 제거 — 마크 href 가 아닌 텍스트 매칭에만 적용. */
function trimTrailingPunct(url: string): string {
	return url.replace(/[.,;:!?)\]}'"]+$/, '');
}

export type ExtractResult =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string }
	| { kind: 'pending' };

export interface ExtractItem {
	source: string;
	result: ExtractResult;
	liPos: number; // top-level listItem 시작 pos (데코 anchor)
}
export interface ExtractNote {
	isExtract: boolean;
	items: ExtractItem[];
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
 * 사람이 보는 링크 텍스트는 일부러 버린다(소스 라인은 에디터가 입력 그대로 렌더).
 */
export function itemSource(li: PMNode): string {
	const first = li.firstChild;
	if (first) {
		const u = firstUrlAndText(first);
		if (u) return u.url;
	}
	return headText(li);
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
	const isExtract = title.startsWith(PREFIX);
	if (!isExtract) return { isExtract, items: [] };
	const items: ExtractItem[] = [];
	doc.forEach((block, offset) => {
		if (!isListNode(block)) return;
		block.forEach((li, liOffset) => {
			if (li.type.name !== 'listItem') return;
			const source = itemSource(li);
			if (!source) return;
			items.push({ source, result: resultOf(li), liPos: offset + 1 + liOffset });
		});
	});
	return { isExtract, items };
}

export function pendingItems(note: ExtractNote): ExtractItem[] {
	return note.items.filter((it) => it.result.kind !== 'done');
}

/** 라우트 마운트 게이트용 — JSON doc 첫 단락만 보고 음악추출 노트인지. */
export function isExtractNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(PREFIX);
}
