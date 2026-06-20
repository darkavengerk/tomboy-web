import type { EditorView } from '@tiptap/pm/view';
import {
	readPlaylistResult,
	buildMusicNoteDoc,
	musicNoteTitleFor
} from '$lib/musicExtract/buildMusicNote.js';
import { findNoteByTitle, createNote, updateNoteFromEditor } from '$lib/core/noteManager.js';
import { pushToast } from '$lib/stores/toast.js';

/**
 * 완료 재생목록(source)으로부터 '음악::<label>' 노트를 만든다(이미 있으면 그대로 연다).
 * 트랙은 buildMusicNoteDoc 가 체크된 플레이리스트 블록으로 채워 바로 재생 가능.
 * 생성·존재 모두 oninternallink(title) 로 그 노트로 이동.
 */
export async function createMusicNoteFromPlaylist(
	view: EditorView,
	source: string,
	oninternallink?: (title: string) => void
): Promise<void> {
	const result = readPlaylistResult(view.state.doc, source);
	if (!result || result.urls.length === 0) {
		pushToast('추출된 트랙이 없습니다', { kind: 'error' });
		return;
	}
	const title = musicNoteTitleFor(result.label);

	// 제목 전역 유일 불변식 — 이미 있으면 새로 만들지 않고 그 노트를 연다(사용자 편집 보존).
	const existing = await findNoteByTitle(title);
	if (existing && !existing.deleted) {
		pushToast(`이미 있는 음악 노트를 엽니다: ${title}`, { kind: 'info' });
		oninternallink?.(title);
		return;
	}

	const note = await createNote(title);
	await updateNoteFromEditor(note.guid, buildMusicNoteDoc(title, result.label, result.urls));
	pushToast(`음악 노트를 만들었습니다: ${title} (${result.urls.length}곡)`, { kind: 'info' });
	oninternallink?.(title);
}
