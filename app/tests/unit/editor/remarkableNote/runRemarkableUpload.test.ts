import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';

vi.mock('$lib/remarkable/uploadRemarkable.js', () => ({
  uploadRemarkable: vi.fn(),
  RemarkableUploadError: class extends Error {
    constructor(public kind: string, public detail?: string) {
      super(kind);
    }
  }
}));
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

import {
  runRemarkableUpload,
  formatLogLines
} from '$lib/editor/remarkableNote/runRemarkableUpload.js';
import { uploadRemarkable, RemarkableUploadError } from '$lib/remarkable/uploadRemarkable.js';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** Minimal EditorView stub. Includes setProps so setEditable() works. */
function makeMinimalView() {
  return {
    isDestroyed: false,
    state: {},
    dispatch: vi.fn(),
    setProps: vi.fn()
  } as unknown as EditorView;
}

describe('formatLogLines', () => {
  it('formats a single trigger line with notebook name', () => {
    const now = new Date('2026-06-06T11:23:00');
    const lines = formatLogLines(now, { notebook: 'Diary' });
    expect(lines).toEqual(['2026-06-06 11:23 — Diary 트리거됨']);
  });
  it('falls back to "리마커블" when notebook is empty', () => {
    const lines = formatLogLines(new Date('2026-06-06T10:00:00'), { notebook: '' });
    expect(lines).toEqual(['2026-06-06 10:00 — 리마커블 트리거됨']);
  });
  it('uses em-dash (U+2014)', () => {
    const lines = formatLogLines(new Date('2026-06-06T09:00:00'), { notebook: 'X' });
    expect(lines[0]).toContain('—');
    expect(lines[0]).not.toContain(' - ');
  });
});

describe('runRemarkableUpload (callbacks)', () => {
  it('calls uploadRemarkable with notebook from spec', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({ notebook: 'Diary' });
    const view = makeMinimalView();
    await runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' });
    expect(uploadRemarkable).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Diary' })
    );
  });

  it('calls uploadRemarkable with undefined notebook when not set', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({ notebook: '' });
    const view = makeMinimalView();
    await runRemarkableUpload(view, { isRemarkableNote: true, notebook: undefined });
    expect(uploadRemarkable).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: undefined })
    );
  });

  it('resolves without throwing on RemarkableUploadError (error swallowed)', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('automation_unreachable', 'timeout')
    );
    const view = makeMinimalView();
    await expect(
      runRemarkableUpload(view, { isRemarkableNote: true, notebook: undefined })
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing on network error (swallowed)', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('network', 'failed')
    );
    const view = makeMinimalView();
    await expect(
      runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' })
    ).resolves.toBeUndefined();
  });
});

describe('setEditable during upload', () => {
  function makeView() {
    const setPropsCalls: Array<{ editable?: boolean }> = [];
    return {
      isDestroyed: false,
      state: {},
      dispatch: vi.fn(),
      setProps: vi.fn((p: { editable?: () => boolean }) => {
        setPropsCalls.push({ editable: p.editable?.() });
      }),
      _setPropsCalls: setPropsCalls
    };
  }

  it('disables and re-enables editor during upload', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({ notebook: 'Diary' });
    const view = makeView();
    await runRemarkableUpload(view as unknown as EditorView, { isRemarkableNote: true, notebook: 'Diary' });
    expect(view._setPropsCalls).toHaveLength(2);
    expect(view._setPropsCalls[0].editable).toBe(false);
    expect(view._setPropsCalls[1].editable).toBe(true);
  });

  it('re-enables editor when uploadRemarkable throws', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('automation_unreachable', 'timeout')
    );
    const view = makeView();
    await runRemarkableUpload(view as unknown as EditorView, { isRemarkableNote: true, notebook: 'Diary' });
    expect(view._setPropsCalls).toHaveLength(2);
    expect(view._setPropsCalls[0].editable).toBe(false);
    expect(view._setPropsCalls[1].editable).toBe(true);
  });
});

describe('Korean error mappings', () => {
  const cases: [string, string][] = [
    ['not_configured', '브릿지 설정이 필요합니다'],
    ['unauthorized', '인증 실패 — 설정에서 브릿지 재로그인'],
    ['automation_unreachable', '데스크탑 파이프라인 트리거 실패 — 1분 내 자동 처리됩니다'],
    ['upstream_error', '브릿지/서비스 응답 오류'],
    ['network', '연결 실패'],
    ['internal', '알 수 없는 오류']
  ];

  for (const [kind, expectedMsg] of cases) {
    it(`maps ${kind} to correct Korean message`, async () => {
      const { pushToast } = await import('$lib/stores/toast.js');
      (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
        new (RemarkableUploadError as any)(kind)
      );
      const view = makeMinimalView();
      await runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' });
      expect(pushToast).toHaveBeenCalledWith(expectedMsg, expect.objectContaining({ kind: 'error' }));
    });
  }
});
