import type { EditorView } from '@tiptap/pm/view';
import { parseExtractNote, pendingItems } from '$lib/musicExtract/parseExtractNote.js';
import { extractOne, ExtractError, type ExtractErrorKind } from '$lib/musicExtract/extractClient.js';
import { writeExtractResult } from '$lib/musicExtract/writeExtractResult.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<ExtractErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	network: '음악 추출 서비스에 연결할 수 없습니다',
	service_unavailable: '음악 추출 서비스에 연결할 수 없습니다',
	unauthorized: '브릿지 인증이 필요합니다',
	bad_request: '잘못된 소스',
	upstream_error: '음악 추출 서비스 오류'
};

/** ⟳ 진행: 대기(신규+실패) 항목을 순차 추출해 결과를 노트에 기록. */
export async function runExtractButtonClick(view: EditorView): Promise<void> {
	const pending = pendingItems(parseExtractNote(view.state.doc));
	if (pending.length === 0) {
		pushToast('추출할 항목이 없습니다', { kind: 'info' });
		return;
	}
	let ok = 0;
	let fail = 0;
	for (const item of pending) {
		if (view.isDestroyed) break;
		try {
			const { url, title } = await extractOne({ source: item.source });
			writeExtractResult(view, item.source, { kind: 'done', url, title });
			ok++;
		} catch (err) {
			const kind: ExtractErrorKind = err instanceof ExtractError ? err.kind : 'network';
			writeExtractResult(view, item.source, { kind: 'error', message: KIND_MESSAGES[kind] ?? '추출 실패' });
			fail++;
		}
	}
	if (view.isDestroyed) return;
	const summary = `${ok}곡 추출${fail ? `, ${fail}곡 실패` : ''}`;
	pushToast(summary, { kind: fail && !ok ? 'error' : 'info' });
}
