import type { Node as PMNode } from '@tiptap/pm/model';

const TITLE_PREFIX = '음악::';
const SUNO_RE = /^SUNO:\s*(https?:\/\/\S+)/i;
const PLAYLIST_HEADER_RE = /^(?:\[[ xX]\]\s*)?플레이리스트:/;

export interface SunoLine {
	url: string;
	paraPos: number; // 단락 시작 pos
	alreadyImported: boolean;
}

/** 단락 텍스트가 SUNO:<url> 형식이면 url 반환, 아니면 null. */
export function matchSunoLine(node: PMNode): string | null {
	if (node.type.name !== 'paragraph') return null;
	const m = SUNO_RE.exec(node.textContent.trim());
	return m ? m[1] : null;
}

function isPlaylistHeader(node: PMNode | undefined): boolean {
	return !!node && node.type.name === 'paragraph' && PLAYLIST_HEADER_RE.test(node.textContent.trim());
}

/** 음악:: 노트의 모든 SUNO: 줄. 바로 다음 블록이 플레이리스트 헤더면 alreadyImported. */
export function parseSunoLines(doc: PMNode): SunoLine[] {
	const title = doc.firstChild?.textContent.trim() ?? '';
	if (!title.startsWith(TITLE_PREFIX)) return [];
	const blocks: { node: PMNode; offset: number }[] = [];
	doc.forEach((node, offset) => blocks.push({ node, offset }));
	const lines: SunoLine[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const url = matchSunoLine(blocks[i].node);
		if (!url) continue;
		lines.push({ url, paraPos: blocks[i].offset, alreadyImported: isPlaylistHeader(blocks[i + 1]?.node) });
	}
	return lines;
}
