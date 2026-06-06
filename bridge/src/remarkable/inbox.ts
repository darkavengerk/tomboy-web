import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface InboxEntry {
  present: boolean;
  mtime: number;
  received_at: string;
}

export type InboxIndex = Record<string, InboxEntry>;

export function readInboxIndex(stateDir: string): InboxIndex {
  const path = join(stateDir, 'index.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InboxIndex;
  } catch {
    return {};
  }
}

export function diffNewUuids(uuids: string[], idx: InboxIndex): string[] {
  return uuids.filter((u) => !idx[u]);
}

export function updateInboxIndex(stateDir: string, additions: InboxIndex): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const merged = { ...readInboxIndex(stateDir), ...additions };
  writeFileSync(join(stateDir, 'index.json'), JSON.stringify(merged, null, 2));
}
