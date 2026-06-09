import type { EditorView } from '@tiptap/pm/view';
import { fetchSunoPlaylist, SunoError, type SunoErrorKind } from '$lib/music/sunoClient.js';
import { writeSunoPlaylistBlock } from '$lib/music/writeSunoPlaylistBlock.js';
import { pushToast } from '$lib/stores/toast.js';

const KIND_MESSAGES: Record<SunoErrorKind, string> = {
	not_configured: '브릿지 설정이 필요합니다',
	unauthorized: '브릿지 인증이 필요합니다',
	service_unavailable: 'Suno 가져오기 서비스에 연결할 수 없습니다',
	network: 'Suno 가져오기 서비스에 연결할 수 없습니다',
	bad_request: '잘못된 Suno 재생목록 URL',
	upstream_error: 'Suno 재생목록을 읽을 수 없습니다',
	empty: '재생목록을 읽을 수 없습니다'
};

/** 한 SUNO: 줄 처리: 브릿지로 열거 → 패턴A 블록 삽입 → 토스트. */
export async function runSunoImportClick(view: EditorView, sunoUrl: string): Promise<void> {
	let result;
	try {
		result = await fetchSunoPlaylist({ url: sunoUrl });
	} catch (err) {
		const kind = err instanceof SunoError ? err.kind : 'network';
		if (!view.isDestroyed) pushToast(KIND_MESSAGES[kind] ?? 'Suno 가져오기 실패', { kind: 'error' });
		return;
	}
	if (view.isDestroyed) return;
	const wrote = writeSunoPlaylistBlock(view, sunoUrl, { label: result.label, tracks: result.tracks });
	if (!wrote) {
		pushToast('가져오기 결과를 추가할 수 없습니다', { kind: 'error' });
		return;
	}
	const parts = [`${result.tracks.length}곡 가져옴`];
	if (result.truncated) parts.push('상한 초과 일부만');
	pushToast(parts.join(', '), { kind: 'info' });
}
