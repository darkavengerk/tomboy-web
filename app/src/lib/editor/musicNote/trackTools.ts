/**
 * Pure doc-mutation + clipboard helpers for the playlist "Ctrl 편집" mode.
 *
 * The plugin reveals per-track ▲▼ / 복사 / 삭제 buttons while Ctrl(또는 Mac ⌘)
 * is held. The actual transaction shapes + copy payloads live here so they can
 * be unit-tested without a DOM or a live EditorView. The plugin re-derives from
 * the *live* doc at click time and applies these results.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { MusicTrack } from '$lib/music/parseMusicNote.js';

function isListNode(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

/**
 * 트랙 li 삭제 범위. 그 li 가 리스트의 유일한 자식이면 리스트째 지워 빈-리스트
 * 스키마 위반을 피한다(헤더 단락은 남아 빈 플레이리스트 상태가 됨). liPos 가
 * listItem 시작이 아니면 null.
 */
export function deleteTrackRange(doc: PMNode, liPos: number): { from: number; to: number } | null {
	const li = doc.nodeAt(liPos);
	if (!li || li.type.name !== 'listItem') return null;
	const $pos = doc.resolve(liPos);
	const list = $pos.parent;
	if (isListNode(list) && list.childCount === 1) {
		return { from: $pos.before(), to: $pos.after() };
	}
	return { from: liPos, to: liPos + li.nodeSize };
}

/**
 * 트랙 li 를 같은 리스트의 인접 형제 listItem 과 교환하는 replaceWith 스펙.
 * 경계(첫 곡의 'up' / 끝 곡의 'down')거나 인접 형제가 listItem 이 아니면 null.
 * 반환된 nodes 를 그대로 `tr.replaceWith(from, to, nodes)` 에 넘기면 순서가 바뀐다.
 */
export function moveTrackSwap(
	doc: PMNode,
	liPos: number,
	dir: 'up' | 'down'
): { from: number; to: number; nodes: PMNode[] } | null {
	const li = doc.nodeAt(liPos);
	if (!li || li.type.name !== 'listItem') return null;
	const $pos = doc.resolve(liPos);
	const list = $pos.parent;
	if (!isListNode(list)) return null;
	const index = $pos.index();
	const target = dir === 'up' ? index - 1 : index + 1;
	if (target < 0 || target >= list.childCount) return null;
	if (list.child(target).type.name !== 'listItem') return null;
	const lo = Math.min(index, target);
	const hi = Math.max(index, target);
	const from = $pos.posAtIndex(lo);
	const to = $pos.posAtIndex(hi + 1);
	const a = list.child(index);
	const b = list.child(target);
	// up: 범위는 [prev, current] → [current, prev]; down: [current, next] → [next, current].
	const nodes = dir === 'up' ? [a, b] : [b, a];
	return { from, to, nodes };
}

/** moveTrackSwap 가 가능한지(=버튼 비활성화 판정). */
export function canMoveTrack(doc: PMNode, liPos: number, dir: 'up' | 'down'): boolean {
	return moveTrackSwap(doc, liPos, dir) !== null;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 다른 플레이리스트에 붙여넣어 같은 곡으로 재생되도록 패턴 A(제목 + 중첩 URL) HTML.
 * URL 은 text===href 인 <a> 로 — tomboyUrlLink 라운드트립(href-from-textContent)을
 * 깨지 않는다. 제목이 없으면(bare URL 트랙) URL 한 줄짜리 li.
 */
export function buildTrackCopyHtml(track: MusicTrack): string {
	const url = escapeHtml(track.url);
	const anchor = `<a href="${url}">${url}</a>`;
	if (track.title) {
		const title = escapeHtml(track.title);
		return `<ul><li><p>${title}</p><ul><li><p>${anchor}</p></li></ul></li></ul>`;
	}
	return `<ul><li><p>${anchor}</p></li></ul>`;
}

/** 일반 텍스트 폴백 — 재생 URL. 리치 미지원 대상엔 bare URL 트랙으로 붙는다. */
export function trackCopyPlain(track: MusicTrack): string {
	return track.url;
}
