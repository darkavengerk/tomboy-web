import type { EditorView } from '@tiptap/pm/view';
import {
	fetchBridgeStatus,
	BridgeStatusError,
	type StatusErrorKind
} from '$lib/bridgeStatus/statusClient.js';
import { writeBridgeDashboard } from '$lib/bridgeStatus/writeBridgeDashboard.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<StatusErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	network: '브릿지에 연결할 수 없습니다',
	service_unavailable: '브릿지에 연결할 수 없습니다',
	unauthorized: '브릿지 인증이 필요합니다',
	bad_request: '잘못된 요청',
	upstream_error: '브릿지 상태 응답 오류'
};

function kindOf(err: unknown): StatusErrorKind {
	return err instanceof BridgeStatusError ? err.kind : 'network';
}

/** ⟳ 갱신: 브릿지 현황을 받아 제목 아래 본문을 통째로 새로 그린다. */
export async function runBridgeButtonClick(view: EditorView): Promise<void> {
	let status;
	try {
		status = await fetchBridgeStatus();
	} catch (err) {
		const kind = kindOf(err);
		if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? '브릿지 상태 조회 실패', { kind: 'error' });
		return;
	}
	if (view.isDestroyed) return;
	const ok = writeBridgeDashboard(view, status);
	pushToast(ok ? '브릿지 현황 갱신' : '갱신할 수 없습니다', { kind: ok ? 'info' : 'error' });
}
