import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { urlChild } from '$lib/musicExtract/writeExtractResult.js';
import { playlistSourceOf, chapterSourceOf, isPlaylistHeaderText } from '$lib/musicExtract/parseExtractNote.js';

const PLAYLIST_HEADER_PREFIX = '플레이리스트:';

export interface PlaylistBlockInput {
	source: string;
	label: string;
	urls: string[];
}

/** 재생목록·챕터 소스 줄을 같은 방식으로 매칭 — 결과 블록은 양쪽 동형(플레이리스트: 헤더). */
function sourceLineMatches(node: PMNode, source: string): boolean {
	return playlistSourceOf(node) === source || chapterSourceOf(node) === source;
}

/** source 문단(미완료=다음 블록이 결과 헤더 아님) 뒤 삽입 위치를 라이브 재탐색. */
function findInsertPos(doc: PMNode, source: string): number | null {
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	for (let i = 1; i < blocks.length; i++) {
		const { node, offset } = blocks[i];
		if (node.type.name !== 'paragraph') continue;
		if (!sourceLineMatches(node, source)) continue;
		const next = blocks[i + 1]?.node;
		if (next && next.type.name === 'paragraph' && isPlaylistHeaderText(next.textContent)) continue; // 이미 결과 있음
		return offset + node.nodeSize;
	}
	return null;
}

/** 소스 줄 아래에 음악:: 호환 플레이리스트 블록([ ]헤더 + mp3 불릿)을 삽입. 작성 시 true. */
export function writePlaylistBlock(view: EditorView, input: PlaylistBlockInput): boolean {
	if (view.isDestroyed || input.urls.length === 0) return false;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return false;

	const pos = findInsertPos(doc, input.source);
	if (pos == null) return false;

	// 프로덕션 스키마엔 InlineCheckbox 가 항상 등록 → atom 헤더(미체크). textContent 는
	// '플레이리스트: label' 이라 parseMusicNote/parseExtractNote 가 인식. inlineCheckbox 미등록
	// (StarterKit-only 테스트)일 때만 '[ ]플레이리스트: label' 텍스트 폴백 — 이 폴백 형태는
	// parseExtractNote(선두 [ ] 허용)는 인식하지만 parseMusicNote(엄격 '플레이리스트:' 접두)는 인식 못함.
	const cb = schema.nodes.inlineCheckbox;
	const header = cb
		? paragraph.create(null, [cb.create({ checked: false }), schema.text(`${PLAYLIST_HEADER_PREFIX} ${input.label}`)])
		: paragraph.create(null, schema.text(`[ ]${PLAYLIST_HEADER_PREFIX} ${input.label}`));
	const list = bulletList.create(
		null,
		input.urls.map((u) => listItem.create(null, paragraph.create(null, urlChild(schema, u))))
	);

	view.dispatch(state.tr.insert(pos, [header, list]));
	return true;
}
