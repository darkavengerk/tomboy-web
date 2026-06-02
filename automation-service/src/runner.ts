import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { CommandEntry } from './registry.js';

export type SpawnFn = typeof nodeSpawn;

export interface RunResult {
  results: Record<string, string>;
  errors: Record<string, string>;
}

export interface RunnerOpts {
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
  cwd?: string;
}

export async function runEntries(entries: CommandEntry[], opts: RunnerOpts = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 5 * 1024 * 1024;
  const spawn = opts.spawn ?? nodeSpawn;
  const cwd = opts.cwd ?? process.env.HOME;

  const results: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const entry of entries) {
    try {
      results[entry.project] = await runOne(entry, { timeoutMs, maxOutputBytes, spawn, cwd });
    } catch (err) {
      errors[entry.project] = (err as Error).message;
    }
  }
  return { results, errors };
}

function runOne(
  entry: CommandEntry,
  o: { timeoutMs: number; maxOutputBytes: number; spawn: SpawnFn; cwd?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = entry.exec;
    const spawnOpts: SpawnOptions = { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = o.spawn(cmd, args, spawnOpts);
    let out = '';
    let errOut = '';
    let size = 0;
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('타임아웃'), o.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size > o.maxOutputBytes) { fail('출력이 너무 큽니다'); return; }
      out += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => { errOut += d.toString('utf8'); });
    child.on('error', (e: Error) => fail(e.message));
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(errOut.trim().slice(0, 200) || `종료 코드 ${code}`));
    });
  });
}
