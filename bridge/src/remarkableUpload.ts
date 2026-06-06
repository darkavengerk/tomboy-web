import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import {
  fetchMetadataDump as defaultFetchDump,
  parseMetadataDump,
  rsyncPage as defaultRsync,
  type RemarkableMetadata,
  type RemarkableSshConfig
} from './remarkable/ssh.js';
import {
  readInboxIndex,
  updateInboxIndex,
  diffNewUuids
} from './remarkable/inbox.js';
import { join, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';

interface RunBody {
  notebook?: unknown;
}

interface Deps {
  secret: string;
  ssh: RemarkableSshConfig;
  inboxDir: string;        // e.g. ~/diary/inbox on Pi; state stored at <inboxDir>/state/
  defaultNotebook: string;
  automationServiceUrl: string;
  // Injected for tests; defaults to real ssh/rsync.
  fetchDump?: (cfg: RemarkableSshConfig) => Promise<string>;
  rsync?: (uuid: string) => Promise<void>;
}

type ErrorKind =
  | 'unauthorized'
  | 'ssh_connect_failed'
  | 'notebook_not_found'
  | 'rsync_failed'
  | 'automation_unreachable'
  | 'internal';

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return pathResolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return pathResolve(p);
}

function epochToDate(ms: number): string {
  if (!ms) return new Date().toISOString().slice(0, 10);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function findNotebookUuid(meta: RemarkableMetadata[], name: string): string | null {
  const hit = meta.find(
    (m) => m.type === 'CollectionType' && m.visibleName === name
  );
  return hit?.uuid ?? null;
}

function listPagesInNotebook(meta: RemarkableMetadata[], notebookUuid: string): RemarkableMetadata[] {
  return meta.filter((m) => m.type === 'DocumentType' && m.parent === notebookUuid);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 64 * 1024;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX) throw new Error('body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

export async function handleRemarkableUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!verifyToken(deps.secret, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  let body: RunBody;
  try {
    body = (await readJson(req)) as RunBody;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_json' }));
    return;
  }
  const notebook =
    typeof body.notebook === 'string' && body.notebook.length > 0
      ? body.notebook
      : deps.defaultNotebook;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  const resolvedInboxDir = expandHome(deps.inboxDir);

  const emitError = (kind: ErrorKind, message?: string) => {
    sendEvent(res, 'error', { kind, message });
    res.end();
  };

  const fetchDump = deps.fetchDump ?? ((cfg) => defaultFetchDump(cfg));
  const rsyncFn = deps.rsync ?? ((uuid) => defaultRsync(deps.ssh, uuid, resolvedInboxDir));

  // ssh_connect + list_pages
  sendEvent(res, 'status', { step: 'ssh_connect' });
  let dump: string;
  try {
    dump = await fetchDump(deps.ssh);
  } catch (err) {
    emitError('ssh_connect_failed', (err as Error).message);
    return;
  }
  const meta = parseMetadataDump(dump);
  const notebookUuid = findNotebookUuid(meta, notebook);
  if (!notebookUuid) {
    emitError('notebook_not_found', `notebook ${notebook}`);
    return;
  }
  const pages = listPagesInNotebook(meta, notebookUuid);
  const stateDir = join(resolvedInboxDir, 'state');
  const inboxIdx = readInboxIndex(stateDir);
  const newUuids = diffNewUuids(pages.map((p) => p.uuid), inboxIdx);
  sendEvent(res, 'status', {
    step: 'list_pages',
    notebook,
    total: pages.length,
    new: newUuids.length
  });

  // rsync_pages
  sendEvent(res, 'status', { step: 'rsync_pages' });
  const additions: Record<string, { present: true; mtime: number; received_at: string }> = {};
  for (const uuid of newUuids) {
    try {
      await rsyncFn(uuid);
      const m = pages.find((p) => p.uuid === uuid);
      additions[uuid] = {
        present: true,
        mtime: m?.lastModified ?? Date.now(),
        received_at: new Date().toISOString()
      };
    } catch (err) {
      // partial-failure: log to stderr, exclude from done
      console.warn(`[remarkable] rsync ${uuid} failed: ${(err as Error).message}`);
    }
  }
  if (Object.keys(additions).length > 0) {
    try {
      updateInboxIndex(stateDir, additions);
    } catch (err) {
      emitError('rsync_failed', `inbox index update: ${(err as Error).message}`);
      return;
    }
  }

  // trigger_pipeline (automation-service)
  sendEvent(res, 'status', { step: 'trigger_pipeline' });
  try {
    const upstream = await fetch(`${deps.automationServiceUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.secret}`
      },
      body: JSON.stringify({ command: 'pipeline-run' })
    });
    if (!upstream.ok) {
      emitError('automation_unreachable', `status ${upstream.status}`);
      return;
    }
  } catch (err) {
    emitError('automation_unreachable', (err as Error).message);
    return;
  }

  const donePages = Object.keys(additions).map((uuid) => {
    const m = pages.find((p) => p.uuid === uuid);
    return { uuid, date: epochToDate(m?.lastModified ?? 0) };
  });
  sendEvent(res, 'done', { notebook, pages: donePages });
  res.end();
}
