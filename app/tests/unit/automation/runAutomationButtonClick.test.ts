import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/automation/runAutomation.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/automation/runAutomation.js')>(
    '$lib/automation/runAutomation.js'
  );
  return { ...actual, runAutomation: vi.fn() };
});
vi.mock('$lib/automation/applyDataNoteCsv.js', () => ({ applyDataNoteCsv: vi.fn() }));
vi.mock('$lib/automation/appendRunHistory.js', () => ({ appendRunHistory: vi.fn() }));
vi.mock('$lib/stores/toast.js', () => ({ pushToast: vi.fn() }));

import { runAutomationButtonClick } from '$lib/editor/automationNote/runAutomationButtonClick.js';
import { runAutomation, AutomationError } from '$lib/automation/runAutomation.js';
import { applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
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
});
