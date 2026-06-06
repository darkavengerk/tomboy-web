import type { EditorView } from '@tiptap/pm/view';
import { parseExtractNote, pendingItems, type SingleItem } from '$lib/musicExtract/parseExtractNote.js';
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

// 시스템 오류(브릿지/서비스 전체 문제) — 한 항목에서 나면 나머지도 같은 결과이므로
// 노트에 같은 에러를 도배하지 않고 토스트만 띄운 뒤 중단(항목은 대기 유지 → 재시도 가능).
// 항목별 오류(bad_request=소스 거부, upstream_error=그 곡 추출 실패)는 해당 항목만 실패로 기록하고 계속.
const SYSTEMIC: ReadonlySet<ExtractErrorKind> = new Set<ExtractErrorKind>([
	'not_configured',
	'unauthorized',
	'service_unavailable',
	'network'
]);

/** ⟳ 진행: 대기(신규+실패) 항목을 순차 추출해 결과를 노트에 기록. */
export async function runExtractButtonClick(view: EditorView): Promise<void> {
	// TODO(Task 8): 재생목록(playlist) 분기 추가 시 이 필터 제거. 그 전까지는 단일 곡만 처리.
	const pending = pendingItems(parseExtractNote(view.state.doc)).filter(
		(it): it is SingleItem => it.kind === 'single'
	);
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
			if (SYSTEMIC.has(kind)) {
				if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '음악 추출 실패', { kind: 'error' });
				return;
			}
			writeExtractResult(view, item.source, { kind: 'error', message: KIND_MESSAGES[kind] ?? '추출 실패' });
			fail++;
		}
	}
	if (view.isDestroyed) return;
	const parts: string[] = [];
	if (ok) parts.push(`${ok}곡 추출`);
	if (fail) parts.push(`${fail}곡 실패`);
	const summary = parts.join(', ') || '변경 없음';
	pushToast(summary, { kind: fail && !ok ? 'error' : 'info' });
}
