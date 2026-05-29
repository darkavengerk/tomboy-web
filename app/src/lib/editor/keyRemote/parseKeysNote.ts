import type { JSONContent } from '@tiptap/core';

export interface KeysNoteSpec {
	/** 원본 `keys://...` 라인 (트림됨). */
	raw: string;
	host: string;
	user?: string;
	port?: number;
	/** 브리지로 보낼 와이어 타깃 — bridge는 ssh:// 스킴만 파싱하므로 변환해 둔다. */
	sshTarget: string;
}

const KEYS_RE = /^keys:\/\/(?:([^@\s/]+)@)?([^:\s/]+)(?::(\d{1,5}))?\/?\s*$/;

function paragraphText(block: JSONContent | undefined): string | null {
	if (!block || block.type !== 'paragraph') return null;
	if (!block.content) return '';
	let out = '';
	for (const child of block.content) {
		if (child.type === 'text') out += child.text ?? '';
		else return null;
	}
	return out;
}

/**
 * 노트가 키 이벤트 노트인지 판정. 터미널 노트와 동일하게 첫 블록은 제목,
 * 그 다음 첫 비어있지 않은 본문 블록이 `keys://...` 메타 라인이어야 한다.
 */
export function parseKeysNote(doc: JSONContent | null | undefined): KeysNoteSpec | null {
	if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return null;
	const blocks = doc.content;
	if (blocks.length < 2) return null;
	let i = 1;
	while (i < blocks.length && paragraphText(blocks[i]) === '') i++;
	const line = paragraphText(blocks[i]);
	if (line === null) return null;
	const m = KEYS_RE.exec(line.trim());
	if (!m) return null;
	const user = m[1] || undefined;
	const host = m[2];
	const portRaw = m[3];
	const port = portRaw ? Number(portRaw) : undefined;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
	const sshTarget = `ssh://${user ? user + '@' : ''}${host}${port ? ':' + port : ''}`;
	return { raw: line.trim(), host, user, port, sshTarget };
}
