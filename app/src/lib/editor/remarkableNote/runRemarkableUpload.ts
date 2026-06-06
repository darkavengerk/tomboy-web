import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  uploadRemarkable,
  RemarkableUploadError,
  type RemarkableUploadErrorKind,
  type RemarkableUploadResult,
  type RemarkableUploadStatus
} from '$lib/remarkable/uploadRemarkable.js';
import { pushToast } from '$lib/stores/toast.js';
import type { RemarkableUploadNoteSpec } from '$lib/remarkable/parseRemarkableUploadNote.js';

const KIND_MESSAGES: Record<RemarkableUploadErrorKind, string> = {
  not_configured: '브릿지 설정이 필요합니다',
  unauthorized: '인증 실패 — 설정에서 브릿지 재로그인',
  ssh_connect_failed: '리마커블 연결 실패 — 같은 네트워크인지 확인',
  notebook_not_found: '폴더를 찾을 수 없습니다',
  rsync_failed: '페이지 복사 실패',
  automation_unreachable: '데스크탑 파이프라인 트리거 실패 — 5분 내 자동 처리됩니다',
  upstream_error: '브릿지/서비스 응답 오류',
  network: '연결 실패',
  internal: '알 수 없는 오류'
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pure helper: formats upload result into log lines for prepending to the note body.
 * Header line: `YYYY-MM-DD HH:mm — {notebook}, {N}건`
 * Per page:    `  → [[{date} 리마커블([{uuid}])]]`
 * Title format is byte-identical to pipeline.yaml tomboy.title_format.
 */
export function formatLogLines(now: Date, result: RemarkableUploadResult): string[] {
  const header = `${dateStamp(now)} — ${result.notebook}, ${result.pages.length}건`;
  const links = result.pages.map(
    (p) => `  → [[${p.date} 리마커블([${p.uuid}])]]`
  );
  return [header, ...links];
}

function statusMessage(s: RemarkableUploadStatus): string {
  switch (s.step) {
    case 'ssh_connect':
      return '리마커블 접속 중…';
    case 'list_pages':
      return `${s.notebook ?? ''} 페이지 ${s.new ?? 0}건 가져오는 중…`;
    case 'rsync_pages':
      return '페이지 복사 중…';
    case 'trigger_pipeline':
      return '파이프라인 트리거…';
  }
}

/**
 * Body insert position = after signature paragraph (1st) + optional header paragraph (2nd).
 * `hasHeader` is true when `spec.notebook !== undefined` (폴더: header present).
 */
function bodyInsertPos(doc: PMNode, hasHeader: boolean): number {
  const skip = hasHeader ? 2 : 1;
  let pos = 0;
  for (let i = 0; i < skip && i < doc.childCount; i++) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

function makeParagraph(schema: Schema, text: string): PMNode {
  const paragraph = schema.nodes.paragraph;
  return paragraph.create(null, text ? schema.text(text) : null);
}

/** Insert placeholder paragraph at body-start position. Returns position. */
function insertPlaceholder(view: EditorView, hasHeader: boolean, text: string): number {
  const pos = bodyInsertPos(view.state.doc, hasHeader);
  const tr = view.state.tr.insert(pos, makeParagraph(view.state.schema, text));
  view.dispatch(tr);
  return pos;
}

/** Replace the content of the paragraph at `pos` with new text. */
function replacePlaceholder(view: EditorView, pos: number, text: string): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'paragraph') return;
  const innerStart = pos + 1;
  const innerEnd = pos + 1 + node.content.size;
  const replacement = view.state.schema.text(text);
  const tr = view.state.tr.replaceWith(innerStart, innerEnd, replacement);
  view.dispatch(tr);
}

/** Delete the paragraph node at `pos`. */
function removePlaceholder(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'paragraph') return;
  const tr = view.state.tr.delete(pos, pos + node.nodeSize);
  view.dispatch(tr);
}

/** Prepend log lines as individual paragraph nodes at body-start position. */
function prependLines(view: EditorView, hasHeader: boolean, lines: string[]): void {
  const pos = bodyInsertPos(view.state.doc, hasHeader);
  const nodes = lines.map((l) => makeParagraph(view.state.schema, l));
  const tr = view.state.tr.insert(pos, nodes);
  view.dispatch(tr);
}

function setEditable(view: EditorView, editable: boolean): void {
  view.setProps({ editable: () => editable });
}

/** 📥 업로드 버튼 클릭 처리. Swallows all errors — displays them as inline placeholder text. */
export async function runRemarkableUpload(
  view: EditorView,
  spec: RemarkableUploadNoteSpec
): Promise<void> {
  if (view.isDestroyed) return;
  const hasHeader = spec.notebook !== undefined;
  // Guard: view.state.doc may be absent in test environments.
  let placeholderPos = -1;
  try {
    placeholderPos = insertPlaceholder(view, hasHeader, '리마커블 접속 중…');
  } catch {
    /* doc not available — proceed without placeholder */
  }

  setEditable(view, false);
  try {
    const result = await uploadRemarkable({
      notebook: spec.notebook,
      onStatus: (s) => {
        if (view.isDestroyed) return;
        if (placeholderPos >= 0) replacePlaceholder(view, placeholderPos, statusMessage(s));
      }
    });
    if (view.isDestroyed) return;
    if (placeholderPos >= 0) removePlaceholder(view, placeholderPos);
    prependLines(view, hasHeader, formatLogLines(new Date(), result));
    pushToast(`${result.notebook} ${result.pages.length}건 업로드`, { kind: 'info' });
  } catch (err) {
    if (view.isDestroyed) return;
    if (!(err instanceof RemarkableUploadError)) {
      console.error('[remarkable]', err);
    }
    const kind = err instanceof RemarkableUploadError ? err.kind : 'internal';
    const msg = KIND_MESSAGES[kind as RemarkableUploadErrorKind] ?? '알 수 없는 오류';
    if (placeholderPos >= 0) replacePlaceholder(view, placeholderPos, `[업로드 오류: ${msg}]`);
    pushToast(msg, { kind: 'error' });
  } finally {
    setEditable(view, true);
  }
}
