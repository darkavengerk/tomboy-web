import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { urlChild } from '$lib/musicExtract/writeExtractResult.js';
import { matchSunoLine } from '$lib/music/parseSunoLine.js';

const PLAYLIST_HEADER_PREFIX = '플레이리스트:';
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

export interface SunoBlockInput {
	label: string;
	tracks: { url: string; title: string }[];
}

/** url 과 일치하는 미가져온 SUNO: 단락 뒤 삽입 위치를 라이브 재탐색. */
function findInsertPos(doc: PMNode, sunoUrl: string): number | null {
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	for (let i = 0; i < blocks.length; i++) {
		const { node, offset } = blocks[i];
		if (matchSunoLine(node) !== sunoUrl) continue;
		const next = blocks[i + 1]?.node;
		if (next && next.type.name === 'paragraph' && PLAYLIST_HEADER_RE.test(next.textContent.trim())) continue; // 이미 결과
		return offset + node.nodeSize;
	}
	return null;
}

/** SUNO: 줄 아래에 음악:: 호환 패턴A 플레이리스트 블록([x]헤더 + 제목/URL 트랙)을 삽입. 작성 시 true. */
export function writeSunoPlaylistBlock(view: EditorView, sunoUrl: string, input: SunoBlockInput): boolean {
	if (view.isDestroyed || input.tracks.length === 0) return false;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return false;

	const pos = findInsertPos(doc, sunoUrl);
	if (pos == null) return false;

	// 프로덕션 스키마엔 InlineCheckbox 가 항상 등록 → atom 헤더(체크됨=즉시 재생 가능).
	// inlineCheckbox 미등록(StarterKit-only 테스트)일 때만 '[x]플레이리스트: label' 텍스트 폴백.
	const cb = schema.nodes.inlineCheckbox;
	const header = cb
		? paragraph.create(null, [cb.create({ checked: true }), schema.text(`${PLAYLIST_HEADER_PREFIX} ${input.label}`)])
		: paragraph.create(null, schema.text(`[x]${PLAYLIST_HEADER_PREFIX} ${input.label}`));

	// 패턴 A: <li><p>제목</p><ul><li><p>urlChild(audio_url)</p></li></ul></li>
	const list = bulletList.create(
		null,
		input.tracks.map((tk) =>
			listItem.create(null, [
				paragraph.create(null, schema.text(tk.title)),
				bulletList.create(null, [listItem.create(null, paragraph.create(null, urlChild(schema, tk.url)))])
			])
		)
	);

	view.dispatch(state.tr.insert(pos, [header, list]));
	return true;
}
