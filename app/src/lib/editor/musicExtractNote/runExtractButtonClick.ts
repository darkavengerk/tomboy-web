import type { EditorView } from '@tiptap/pm/view';
import { parseExtractNote, pendingItems } from '$lib/musicExtract/parseExtractNote.js';
import { extractOne, enumeratePlaylist, ExtractError, type ExtractErrorKind } from '$lib/musicExtract/extractClient.js';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { writePlaylistBlock } from '$lib/musicExtract/writePlaylistBlock.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<ExtractErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	network: '음악 추출 서비스에 연결할 수 없습니다',
	service_unavailable: '음악 추출 서비스에 연결할 수 없습니다',
	unauthorized: '브릿지 인증이 필요합니다',
	too_large: '파일이 용량 상한을 초과했습니다',
	bad_request: '잘못된 소스',
	upstream_error: '음악 추출 서비스 오류'
};

// 시스템 오류(브릿지/서비스 전체 문제) — 한 항목에서 나면 나머지도 같으므로 토스트만 띄우고 중단.
const SYSTEMIC: ReadonlySet<ExtractErrorKind> = new Set<ExtractErrorKind>([
	'not_configured',
	'unauthorized',
	'service_unavailable',
	'network'
]);

function kindOf(err: unknown): ExtractErrorKind {
	return err instanceof ExtractError ? err.kind : 'network';
}

interface Tally {
	singleOk: number;
	singleFail: number;
	playlistDone: number;
	playlistTracks: number;
	truncated: number;
}

type ProcessOutcome = 'ok' | 'stop';

/** ⟳ 진행: 대기(신규+실패) 항목을 순차 처리. systemic 오류면 'stop' 반환(전체 중단). */
async function processSingle(view: EditorView, source: string, t: Tally): Promise<ProcessOutcome> {
	try {
		const { url, title } = await extractOne({ source });
		if (view.isDestroyed) return 'stop';
		writeExtractResult(view, source, { kind: 'done', url, title });
		t.singleOk++;
	} catch (err) {
		const kind = kindOf(err);
		if (SYSTEMIC.has(kind)) {
			if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
			return 'stop';
		}
		if (view.isDestroyed) return 'stop';
		writeExtractResult(view, source, { kind: 'error', message: KIND_MESSAGES[kind] ?? '추출 실패' });
		t.singleFail++;
	}
	return 'ok';
}

async function processPlaylist(view: EditorView, source: string, t: Tally): Promise<ProcessOutcome> {
	let enumerated;
	try {
		enumerated = await enumeratePlaylist({ source });
	} catch (err) {
		const kind = kindOf(err);
		if (SYSTEMIC.has(kind)) {
			if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
			return 'stop';
		}
		if (!view.isDestroyed) pushToast(`재생목록 열거 실패: ${KIND_MESSAGES[kind] ?? ''}`, { kind: 'error' });
		return 'ok'; // 다음 항목으로
	}
	const urls: string[] = [];
	for (const entry of enumerated.entries) {
		if (view.isDestroyed) return 'stop';
		try {
			const { url } = await extractOne({ source: entry.url });
			urls.push(url);
		} catch (err) {
			const kind = kindOf(err);
			if (SYSTEMIC.has(kind)) {
				if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
				return 'stop';
			}
			// 곡별 실패는 카운트하지 않고 건너뜀(블록엔 성공곡만 — 부분 성공 허용).
		}
	}
	if (urls.length > 0 && writePlaylistBlock(view, { source, label: enumerated.label, urls })) {
		t.playlistDone++;
		t.playlistTracks += urls.length;
		if (enumerated.truncated) t.truncated++; // 블록을 실제로 쓴 경우에만 잘림 보고
	}
	return 'ok';
}

export async function runExtractButtonClick(view: EditorView): Promise<void> {
	const pending = pendingItems(parseExtractNote(view.state.doc));
	if (pending.length === 0) {
		pushToast('추출할 항목이 없습니다', { kind: 'info' });
		return;
	}
	const t: Tally = { singleOk: 0, singleFail: 0, playlistDone: 0, playlistTracks: 0, truncated: 0 };
	for (const item of pending) {
		if (view.isDestroyed) break;
		const outcome = item.kind === 'single' ? await processSingle(view, item.source, t) : await processPlaylist(view, item.source, t);
		if (outcome === 'stop') return;
	}
	if (view.isDestroyed) return;
	const parts: string[] = [];
	if (t.playlistDone) parts.push(`재생목록 ${t.playlistDone}개(${t.playlistTracks}곡)`);
	if (t.singleOk) parts.push(`${t.singleOk}곡 추출`);
	if (t.singleFail) parts.push(`${t.singleFail}곡 실패`);
	if (t.truncated) parts.push(`상한 초과 ${t.truncated}개 일부만`);
	const summary = parts.join(', ') || '변경 없음';
	const isError = t.singleFail > 0 && t.singleOk === 0 && t.playlistDone === 0;
	pushToast(summary, { kind: isError ? 'error' : 'info' });
}
