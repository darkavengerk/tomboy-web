import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/automation/runAutomation.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/automation/runAutomation.js')>(
    '$lib/automation/runAutomation.js'
  );
  return { ...actual, runAutomation: vi.fn() };
});
vi.mock('$lib/automation/applyDataNoteCsv.js', () => ({ applyDataNoteCsv: vi.fn() }));
vi.mock('$lib/automation/applyChartNote.js', () => ({ applyChartNote: vi.fn() }));
vi.mock('$lib/automation/localCommands.js', () => ({ getLocalCommand: vi.fn() }));
vi.mock('$lib/automation/appendRunHistory.js', () => ({ appendRunHistory: vi.fn() }));
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

import { runAutomationButtonClick } from '$lib/editor/automationNote/runAutomationButtonClick.js';
import { runAutomation, AutomationError } from '$lib/automation/runAutomation.js';
import { applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { applyChartNote } from '$lib/automation/applyChartNote.js';
import { getLocalCommand } from '$lib/automation/localCommands.js';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';
import { pushToast } from '$lib/stores/toast.js';

const view = { isDestroyed: false } as never; // appendRunHistory is mocked, view unused
const m = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('runAutomationButtonClick', () => {
  it('applies each result and logs a summary on success', async () => {
    m(runAutomation).mockResolvedValue({ results: { tomboy: 'csvA', robotC: 'csvB' }, errors: {} });
    m(applyDataNoteCsv).mockResolvedValueOnce('updated').mockResolvedValueOnce('created');
    await runAutomationButtonClick(view, 'loc-history');
    expect(m(applyDataNoteCsv).mock.calls.map((c) => c[0])).toEqual(['tomboy', 'robotC']);
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/DATA::robotC 생성/);
    expect(logged).toMatch(/tomboy 갱신/);
    expect(pushToast).toHaveBeenCalled();
  });

  it('on AutomationError shows error toast and logs 실패', async () => {
    m(runAutomation).mockRejectedValue(new AutomationError('service_unavailable'));
    await runAutomationButtonClick(view, 'loc-history');
    expect(applyDataNoteCsv).not.toHaveBeenCalled();
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/실패/);
    expect(m(pushToast).mock.calls[0][1]).toMatchObject({ kind: 'error' });
  });

  it('reflects per-project errors in the summary', async () => {
    m(runAutomation).mockResolvedValue({ results: { tomboy: 'csvA' }, errors: { robotC: '타임아웃' } });
    m(applyDataNoteCsv).mockResolvedValue('updated');
    await runAutomationButtonClick(view, 'loc-history');
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/tomboy 갱신/);
    expect(logged).toMatch(/robotC 실패\(타임아웃\)/);
  });

  it('runs a local command without the bridge and ensures its chart note', async () => {
    m(getLocalCommand).mockReturnValue(async () => ({
      results: { 'note-count': 'week,[0] Slip-Box\n2026-W04,3\n' },
      errors: {},
      charts: [{ noteTitle: '노트 수 추이', chartTitle: '노트 수 추이', dataNoteTitle: 'DATA::note-count', xColumn: 'week' }]
    }));
    m(applyDataNoteCsv).mockResolvedValue('created');
    m(applyChartNote).mockResolvedValue('created');

    await runAutomationButtonClick(view, 'note-count');

    expect(runAutomation).not.toHaveBeenCalled();
    expect(m(applyDataNoteCsv).mock.calls[0][0]).toBe('note-count');
    expect(m(applyChartNote).mock.calls[0][0]).toMatchObject({ noteTitle: '노트 수 추이' });
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/DATA::note-count 생성/);
    expect(logged).toMatch(/노트 수 추이 차트 생성/);
  });

  it('logs a local failure without hitting the bridge', async () => {
    m(getLocalCommand).mockReturnValue(async () => {
      throw new Error('boom');
    });
    await runAutomationButtonClick(view, 'note-count');
    expect(runAutomation).not.toHaveBeenCalled();
    expect(applyDataNoteCsv).not.toHaveBeenCalled();
    const logged = m(appendRunHistory).mock.calls[0][1] as string;
    expect(logged).toMatch(/실패: 로컬 자동화 실패/);
  });
});
