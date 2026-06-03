import type { Node as PMNode } from '@tiptap/pm/model';
import type { JSONContent } from '@tiptap/core';

const TITLE_PREFIX = '음악::';
const PLAYLIST_PREFIX = '플레이리스트:';
const URL_RE = /https?:\/\/[^\s<>"']+/;

export interface MusicTrack {
	url: string;
	title: string | null;
	display: string;
	liPos: number; // listItem 시작 pos (데코레이션 anchor)
}
export interface MusicPlaylist {
	label: string;
	tracks: MusicTrack[];
}
export interface MusicNote {
	isMusic: boolean;
	name: string;
	playlists: MusicPlaylist[];
	flatQueue: MusicTrack[];
}

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

/** node 안의 첫 http(s) URL — tomboyUrlLink/link 마크 href 우선, 없으면 본문 정규식. */
function firstUrlInNode(node: PMNode): string | null {
	let marked: string | null = null;
	node.descendants((n) => {
		if (marked) return false;
		if (n.isText) {
			// tomboyUrlLink (실제 앱) 또는 link (StarterKit 테스트 환경) 마크 모두 허용
			const link = n.marks.find(
				(m) => m.type.name === 'tomboyUrlLink' || m.type.name === 'link'
			);
			const href = link?.attrs?.href;
			if (typeof href === 'string' && URL_RE.test(href)) {
				marked = href;
				return false;
			}
		}
		return true;
	});
	if (marked) return marked;
	const m = URL_RE.exec(node.textContent);
	return m ? m[0] : null;
}

/** listItem 의 head 텍스트 = 첫 자식(문단) 텍스트, 중첩 리스트 제외. */
function listItemHead(li: PMNode): string {
	const first = li.firstChild;
	return first ? first.textContent.trim() : '';
}

function nestedListOf(li: PMNode): PMNode | null {
	let found: PMNode | null = null;
	li.forEach((child) => {
		if (!found && isListNode(child)) found = child;
	});
	return found;
}

export function deriveName(url: string): string {
	try {
		const u = new URL(url);
		const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
		const decoded = decodeURIComponent(seg);
		const noExt = decoded.replace(/\.[a-z0-9]+$/i, '');
		return noExt || url;
	} catch {
		return url;
	}
}

function extractTrack(li: PMNode, liPos: number): MusicTrack | null {
	const head = listItemHead(li);
	// 패턴 B: head 자체가 URL
	const headMatch = URL_RE.exec(head);
	if (headMatch && headMatch[0] === head.trim()) {
		const url = headMatch[0];
		return { url, title: null, display: deriveName(url), liPos };
	}
	// 패턴 A: head = 제목, 중첩 리스트 첫 아이템에 URL
	const nested = nestedListOf(li);
	if (nested && nested.firstChild) {
		const url = firstUrlInNode(nested.firstChild);
		if (url) return { url, title: head || null, display: head || deriveName(url), liPos };
	}
	// head 자체에 URL 이 끼어있는 단일-깊이 케이스도 허용(패턴 B 변형)
	if (headMatch) {
		const url = headMatch[0];
		return { url, title: null, display: deriveName(url), liPos };
	}
	// tomboyUrlLink mark href 도 별도로 탐색 (head 가 링크 텍스트인 경우)
	const firstChild = li.firstChild;
	if (firstChild) {
		const url = firstUrlInNode(firstChild);
		if (url) return { url, title: null, display: deriveName(url), liPos };
	}
	return null;
}

export function parseMusicNote(doc: PMNode): MusicNote {
	const titleText = doc.firstChild?.textContent.trim() ?? '';
	const isMusic = titleText.startsWith(TITLE_PREFIX);
	const name = isMusic ? titleText.slice(TITLE_PREFIX.length).trim() : '';
	const playlists: MusicPlaylist[] = [];
	if (!isMusic) return { isMusic, name, playlists, flatQueue: [] };

	let pendingLabel: string | null = null;
	doc.forEach((block, offset) => {
		const blockType = block.type.name;
		if (blockType === 'paragraph') {
			const t = block.textContent.trim();
			pendingLabel = t.startsWith(PLAYLIST_PREFIX) ? t.slice(PLAYLIST_PREFIX.length).trim() : null;
			return;
		}
		if (isListNode(block) && pendingLabel !== null) {
			const tracks: MusicTrack[] = [];
			block.forEach((li, liOffset) => {
				if (li.type.name !== 'listItem') return;
				const liPos = offset + 1 + liOffset; // 리스트 content 시작 = offset+1
				const track = extractTrack(li, liPos);
				if (track) tracks.push(track);
			});
			playlists.push({ label: pendingLabel, tracks });
			pendingLabel = null;
			return;
		}
		pendingLabel = null;
	});

	const flatQueue = playlists.flatMap((p) => p.tracks);
	return { isMusic, name, playlists, flatQueue };
}

/** 라우트의 마운트 게이트용 — JSON doc 의 첫 문단만 보고 음악 노트인지 판별. */
export function isMusicNoteDoc(doc: JSONContent | null | undefined): boolean {
	const first = doc?.content?.[0];
	if (!first?.content) return false;
	const text = first.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
	return text.trim().startsWith(TITLE_PREFIX);
}
