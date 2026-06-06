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

describe('formatLogLines', () => {
  it('formats header + per-page lines', () => {
    const now = new Date('2026-06-06T11:23:00');
    const lines = formatLogLines(
      now,
      { notebook: 'Diary', pages: [{ uuid: 'u1', date: '2026-06-06' }, { uuid: 'u2', date: '2026-06-06' }] }
    );
    expect(lines).toEqual([
      '2026-06-06 11:23 — Diary, 2건',
      '  → [[2026-06-06 리마커블([u1])]]',
      '  → [[2026-06-06 리마커블([u2])]]'
    ]);
  });
  it('handles zero pages', () => {
    const lines = formatLogLines(new Date('2026-06-06T10:00:00'), {
      notebook: 'Diary', pages: []
    });
    expect(lines).toEqual(['2026-06-06 10:00 — Diary, 0건']);
  });
  it('uses em-dash (U+2014) in header line', () => {
    const lines = formatLogLines(new Date('2026-06-06T09:00:00'), { notebook: 'X', pages: [] });
    expect(lines[0]).toContain('—');
    expect(lines[0]).not.toContain(' - ');
  });
  it('produces title format byte-identical to pipeline yaml', () => {
    const lines = formatLogLines(new Date('2026-06-06T12:00:00'), {
      notebook: 'Diary',
      pages: [{ uuid: 'abc-123', date: '2026-06-06' }]
    });
    // pipeline.yaml: {date} 리마커블([{page_uuid}])
    expect(lines[1]).toBe('  → [[2026-06-06 리마커블([abc-123])]]');
  });
});

describe('runRemarkableUpload (callbacks)', () => {
  it('calls uploadRemarkable with notebook from spec', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({
      notebook: 'Diary', pages: []
    });
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' });
    expect(uploadRemarkable).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: 'Diary' })
    );
  });

  it('calls uploadRemarkable with undefined notebook when not set', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockResolvedValue({
      notebook: 'default', pages: []
    });
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await runRemarkableUpload(view, { isRemarkableNote: true, notebook: undefined });
    expect(uploadRemarkable).toHaveBeenCalledWith(
      expect.objectContaining({ notebook: undefined })
    );
  });

  it('resolves without throwing on RemarkableUploadError (error swallowed)', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('ssh_connect_failed', 'timeout')
    );
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await expect(
      runRemarkableUpload(view, { isRemarkableNote: true, notebook: undefined })
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing on network error (swallowed)', async () => {
    (uploadRemarkable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new (RemarkableUploadError as any)('network', 'failed')
    );
    const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
    await expect(
      runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' })
    ).resolves.toBeUndefined();
  });
});

describe('Korean error mappings', () => {
  const cases: [string, string][] = [
    ['not_configured', '브릿지 설정이 필요합니다'],
    ['unauthorized', '인증 실패 — 설정에서 브릿지 재로그인'],
    ['ssh_connect_failed', '리마커블 연결 실패 — 같은 네트워크인지 확인'],
    ['notebook_not_found', '폴더를 찾을 수 없습니다'],
    ['rsync_failed', '페이지 복사 실패'],
    ['automation_unreachable', '데스크탑 파이프라인 트리거 실패 — 5분 내 자동 처리됩니다'],
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
      const view = { isDestroyed: false, state: {}, dispatch: vi.fn() } as unknown as EditorView;
      await runRemarkableUpload(view, { isRemarkableNote: true, notebook: 'Diary' });
      expect(pushToast).toHaveBeenCalledWith(expectedMsg, expect.objectContaining({ kind: 'error' }));
    });
  }
});
