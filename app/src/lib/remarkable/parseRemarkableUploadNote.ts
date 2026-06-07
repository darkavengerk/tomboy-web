import type { JSONContent } from '@tiptap/core';

const PREFIX = '리마커블::';
const HEADER_RE = /^폴더:\s*(.*)$/;

/** 시그니처 라인 여부 (제목이 비면 false). */
export function parseRemarkableUploadTitle(titleText: string): boolean {
	const text = titleText.trim();
	if (!text.startsWith(PREFIX)) return false;
	const rest = text.slice(PREFIX.length).trim();
	return rest.length > 0;
}

function paragraphText(node: JSONContent | undefined): string {
	if (!node?.content) return '';
	let out = '';
	for (const c of node.content) {
		if (c.type === 'text') out += c.text ?? '';
		else if (c.type === 'hardBreak') out += '\n';
	}
	return out;
}

export interface RemarkableUploadNoteSpec {
	isRemarkableNote: true;
	notebook: string | undefined;
}

/**
 * 첫 단락 = 시그니처(`리마커블::<제목>`). 둘째 단락이 `폴더: <이름>` 헤더면
 * notebook 설정. 그 외 헤더는 v1에선 인식 안 함.
 */
export function parseRemarkableUploadNote(doc: JSONContent): RemarkableUploadNoteSpec | null {
	const first = doc.content?.[0];
	if (!parseRemarkableUploadTitle(paragraphText(first))) return null;

	let notebook: string | undefined;
	const second = doc.content?.[1];
	if (second) {
		const m = HEADER_RE.exec(paragraphText(second).trim());
		if (m) {
			const value = m[1].trim();
			if (value.length > 0) notebook = value;
		}
	}
	return { isRemarkableNote: true, notebook };
}
