import type { JSONContent } from '@tiptap/core';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { URL_RE, trimTrailingPunct, deriveName, type MusicTrack } from './parseMusicNote.js';

const TITLE_PREFIX = '음악::';
const PLAYLIST_PREFIX = '플레이리스트:';

function nodeText(node: JSONContent | undefined): string {
	if (!node?.content) return typeof node?.text === 'string' ? node.text : '';
	return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/** First http(s) URL inside a JSON node: tomboyUrlLink/link mark href first, else body regex. */
function firstUrlInJson(node: JSONContent | undefined): string | null {
	let marked: string | null = null;
	const walk = (n: JSONContent | undefined) => {
		if (!n || marked) return;
		if (n.type === 'text' && Array.isArray(n.marks)) {
			const link = n.marks.find((m) => m.type === 'tomboyUrlLink' || m.type === 'link');
			const href = (link?.attrs as { href?: unknown })?.href;
			if (typeof href === 'string' && URL_RE.test(href)) {
				marked = href;
				return;
			}
		}
		for (const c of n.content ?? []) walk(c);
	};
	walk(node);
	if (marked) return marked;
	const m = URL_RE.exec(nodeTextDeep(node));
	return m ? trimTrailingPunct(m[0]) : null;
}

/** Concatenated text of all descendant text nodes (for body-regex fallback). */
function nodeTextDeep(node: JSONContent | undefined): string {
	if (!node) return '';
	if (n_isText(node)) return node.text ?? '';
	return (node.content ?? []).map(nodeTextDeep).join('');
}
function n_isText(n: JSONContent): boolean {
	return n.type === 'text';
}

function isListNode(n: JSONContent): boolean {
	return n.type === 'bulletList' || n.type === 'orderedList';
}

/** head 문단 = listItem 의 첫 자식(문단). */
function listItemHead(li: JSONContent): string {
	const first = (li.content ?? [])[0];
	return nodeText(first).trim();
}
function nestedListOf(li: JSONContent): JSONContent | null {
	for (const c of li.content ?? []) if (isListNode(c)) return c;
	return null;
}

function extractTrack(li: JSONContent): MusicTrack | null {
	const head = listItemHead(li);
	const headMatch = URL_RE.exec(head);

	// 패턴 B: head 자체가 정확히 URL
	if (headMatch && headMatch[0] === head.trim()) {
		const url = trimTrailingPunct(headMatch[0]);
		return { url, title: null, display: deriveName(url), liPos: -1 };
	}
	// 패턴 A: head = 제목, 중첩 리스트 첫 아이템에 URL
	const nested = nestedListOf(li);
	const firstNestedLi = nested?.content?.find((c) => c.type === 'listItem');
	if (firstNestedLi) {
		const url = firstUrlInJson((firstNestedLi.content ?? [])[0]);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos: -1 };
	}
	// 패턴 C: head 문단 자체에 마크/링크 URL (link text = 제목)
	const firstChild = (li.content ?? [])[0];
	if (firstChild) {
		const url = firstUrlInJson(firstChild);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos: -1 };
	}
	// 패턴 B 변형: head 안에 URL 끼어있음
	if (headMatch) {
		const url = trimTrailingPunct(headMatch[0]);
		return { url, title: null, display: deriveName(url), liPos: -1 };
	}
	return null;
}

/** Rebuild the flat queue from a music note's raw <note-content> XML. Mirrors
 *  parseMusicNote (PMNode) but walks JSONContent so it runs without an editor. */
export function buildQueueFromXml(xmlContent: string): MusicTrack[] {
	if (!xmlContent) return [];
	const doc = deserializeContent(xmlContent);
	const blocks = doc.content ?? [];
	const titleText = nodeText(blocks[0]).trim();
	if (!titleText.startsWith(TITLE_PREFIX)) return [];

	const out: MusicTrack[] = [];
	let pendingLabel: string | null = null;
	for (const block of blocks) {
		if (block.type === 'paragraph') {
			const t = nodeText(block).trim();
			if (!t.startsWith(PLAYLIST_PREFIX)) {
				pendingLabel = null;
				continue;
			}
			// 헤더 앞 inlineCheckbox atom 의 checked 가 플레이리스트 on/off. 없음=on(레거시).
			const first = (block.content ?? [])[0];
			const enabled =
				first?.type === 'inlineCheckbox'
					? (first.attrs as { checked?: unknown })?.checked === true
					: true;
			pendingLabel = enabled ? t.slice(PLAYLIST_PREFIX.length).trim() : null;
			continue;
		}
		if (isListNode(block) && pendingLabel !== null) {
			for (const li of block.content ?? []) {
				if (li.type !== 'listItem') continue;
				const track = extractTrack(li);
				if (track) {
					track.playlistLabel = pendingLabel ?? '';
					out.push(track);
				}
			}
			pendingLabel = null;
			continue;
		}
		pendingLabel = null;
	}
	return out;
}
