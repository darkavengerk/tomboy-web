/**
 * Debug utility: fetch the server's current version of a note and produce
 * a line-level diff against the locally-stored version. Used by the
 * "원본과 비교하기" action on the note editor to investigate why a note
 * appears on the upload list without any intentional edit.
 */

import * as noteStore from '$lib/storage/noteStore.js';
import { serializeNote, parseNoteFromFile } from '$lib/core/noteArchiver.js';
import {
	downloadServerManifest,
	downloadNoteAtRevision,
	isAuthenticated
} from './dropboxClient.js';

export type DiffType = 'equal' | 'added' | 'removed';
export interface DiffOp {
	type: DiffType;
	text: string;
}

/**
 * Line-level diff based on longest-common-subsequence. O(m*n); fine for
 * note-sized XML (typically a few hundred lines at most).
 */
export function lineDiff(a: string, b: string): DiffOp[] {
	const aLines = a.split('\n');
	const bLines = b.split('\n');
	const m = aLines.length;
	const n = bLines.length;

	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0)
	);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (aLines[i] === bLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (aLines[i] === bLines[j]) {
			ops.push({ type: 'equal', text: aLines[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: 'removed', text: aLines[i] });
			i++;
		} else {
			ops.push({ type: 'added', text: bLines[j] });
			j++;
		}
	}
	while (i < m) ops.push({ type: 'removed', text: aLines[i++] });
	while (j < n) ops.push({ type: 'added', text: bLines[j++] });
	return ops;
}

export interface CompareResult {
	status: 'ok' | 'local-only' | 'error';
	localXml?: string;
	serverXml?: string;
	diff?: DiffOp[];
	message?: string;
	serverRev?: number;
}

/**
 * Fetch server .note XML for this guid and compute a line diff against the
 * locally-serialized .note XML.
 */
export async function compareWithServer(guid: string): Promise<CompareResult> {
	const local = await noteStore.getNote(guid);
	if (!local) {
		return { status: 'error', message: '로컬에 노트가 없습니다' };
	}
	const localXml = serializeNote(local);

	if (!isAuthenticated()) {
		return { status: 'error', localXml, message: '로그인되어 있지 않습니다' };
	}

	let manifest;
	try {
		manifest = await downloadServerManifest();
	} catch (err) {
		return { status: 'error', localXml, message: `서버 매니페스트 로드 실패: ${err}` };
	}
	if (!manifest) {
		return { status: 'error', localXml, message: '서버에 매니페스트가 없습니다' };
	}

	const entry = manifest.notes.find((n) => n.guid === guid);
	if (!entry) {
		return {
			status: 'local-only',
			localXml,
			message: '서버에 이 노트가 아직 없습니다 (새 노트)'
		};
	}

	let rawServer: string;
	try {
		rawServer = await downloadNoteAtRevision(guid, entry.rev);
	} catch (err) {
		return { status: 'error', localXml, message: `서버 파일 다운로드 실패: ${err}` };
	}

	// Re-serialise the server version through our own archiver so that the
	// diff isolates *semantic* differences (content, attributes we care about)
	// from purely formatting / whitespace ones that the parser/serializer
	// would normalise away. Still fall back to raw if parse fails.
	let serverXml: string;
	try {
		const parsed = parseNoteFromFile(rawServer, `${guid}.note`);
		parsed.guid = guid;
		serverXml = serializeNote(parsed);
	} catch {
		serverXml = rawServer;
	}

	const diff = lineDiff(serverXml, localXml);
	return {
		status: 'ok',
		localXml,
		serverXml,
		diff,
		serverRev: entry.rev
	};
}
