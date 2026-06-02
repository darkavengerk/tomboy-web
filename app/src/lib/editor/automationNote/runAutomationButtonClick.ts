import type { EditorView } from '@tiptap/pm/view';
import { runAutomation, AutomationError, type AutomationErrorKind } from '$lib/automation/runAutomation.js';
import { applyDataNoteCsv } from '$lib/automation/applyDataNoteCsv.js';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';
import { pushToast } from '$lib/stores/toast.js';

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const KIND_MESSAGES: Record<AutomationErrorKind, string> = {
  not_configured: '브릿지 설정이 필요합니다',
  network: '자동화 서비스에 연결할 수 없습니다',
  service_unavailable: '자동화 서비스에 연결할 수 없습니다',
  unauthorized: '브릿지 인증이 필요합니다',
  unknown_command: '등록되지 않은 명령입니다',
  bad_request: '요청이 거부되었습니다',
  upstream_error: '자동화 서비스 오류'
};

/** ⟳ 실행 버튼 클릭 처리: 자동화 실행 → DATA:: 노트 갱신 → 로그/토스트. */
export async function runAutomationButtonClick(view: EditorView, commandId: string): Promise<void> {
  let res: { results: Record<string, string>; errors: Record<string, string> };
  try {
    res = await runAutomation({ command: commandId });
  } catch (err) {
    const kind: AutomationErrorKind = err instanceof AutomationError ? err.kind : 'network';
    const msg = KIND_MESSAGES[kind] ?? '자동화 실패';
    pushToast(msg, { kind: 'error' });
    appendRunHistory(view, `${nowStamp()} — 실패: ${msg}`);
    return;
  }

  const updated: string[] = [];
  const created: string[] = [];
  const failed: string[] = [];
  for (const [project, csv] of Object.entries(res.results)) {
    try {
      const outcome = await applyDataNoteCsv(project, csv);
      (outcome === 'created' ? created : updated).push(project);
    } catch {
      failed.push(`${project}(저장 실패)`);
    }
  }
  for (const [project, message] of Object.entries(res.errors)) {
    failed.push(`${project} 실패(${message})`);
  }

  const parts: string[] = [];
  if (created.length) parts.push(`${created.map((p) => `DATA::${p}`).join(', ')} 생성`);
  if (updated.length) parts.push(`${updated.join(', ')} 갱신`);
  if (failed.length) parts.push(failed.join(', '));
  const summary = parts.join(', ') || '변경 없음';

  appendRunHistory(view, `${nowStamp()} — ${summary}`);

  const allFailed = failed.length > 0 && created.length === 0 && updated.length === 0;
  pushToast(summary, { kind: allFailed ? 'error' : 'info' });
}
