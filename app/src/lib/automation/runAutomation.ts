import {
  getDefaultTerminalBridge,
  getTerminalBridgeToken,
  bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export type AutomationErrorKind =
  | 'not_configured'
  | 'unauthorized'
  | 'service_unavailable'
  | 'unknown_command'
  | 'bad_request'
  | 'upstream_error'
  | 'network';

export class AutomationError extends Error {
  constructor(public kind: AutomationErrorKind, public detail?: string) {
    super(`${kind}${detail ? `: ${detail}` : ''}`);
  }
}

export interface AutomationResult {
  results: Record<string, string>;
  errors: Record<string, string>;
}

const STATUS_TO_KIND: Record<number, AutomationErrorKind> = {
  401: 'unauthorized',
  503: 'service_unavailable'
};

export async function runAutomation(opts: {
  command: string;
  signal?: AbortSignal;
}): Promise<AutomationResult> {
  const bridge = await getDefaultTerminalBridge();
  const token = await getTerminalBridgeToken();
  if (!bridge || !token) {
    throw new AutomationError('not_configured', '브릿지 설정이 필요합니다');
  }
  const url = `${bridgeToHttpBase(bridge)}/automation/run`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: opts.command }),
      signal: opts.signal
    });
  } catch (err) {
    throw new AutomationError('network', (err as Error).message);
  }

  if (!res.ok) {
    let bodyErr = '';
    try {
      const j = (await res.json()) as { error?: string };
      bodyErr = typeof j?.error === 'string' ? j.error : '';
    } catch {
      /* ignore */
    }
    if (res.status === 400 && bodyErr === 'unknown_command') {
      throw new AutomationError('unknown_command', bodyErr);
    }
    const kind = STATUS_TO_KIND[res.status] ?? (res.status >= 500 ? 'upstream_error' : 'bad_request');
    throw new AutomationError(kind, bodyErr || undefined);
  }

  const data = (await res.json()) as Partial<AutomationResult>;
  return { results: data.results ?? {}, errors: data.errors ?? {} };
}
