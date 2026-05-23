import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ClaudeRunnerSpawn } from '../src/runner.js';

/**
 * Fake spawn function — replaces node:child_process.spawn in tests.
 * Records args/env/cwd and exposes controls to drive stdout/stderr/exit.
 */
export class FakeChildProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
  stdoutBuf: Buffer[] = [];
  stderrBuf: Buffer[] = [];
  stdout = new Readable({ read() { /* push via emitStdout */ } });
  stderr = new Readable({ read() { /* push via emitStderr */ } });
  killed = false;

  emitStdout(s: string): void { this.stdout.push(s); }
  emitStderr(s: string): void { this.stderr.push(s); }
  endStdout(): void { this.stdout.push(null); }
  endStderr(): void { this.stderr.push(null); }
  exit(code: number): void {
    // Match real child_process behavior: close stdio first, then emit exit.
    // Emit exit asynchronously so that data events from previous push() calls
    // are processed before the exit handler runs.
    this.endStdout();
    this.endStderr();
    setImmediate(() => this.emit('exit', code, null));
  }

  kill(_sig?: string): boolean { this.killed = true; this.exit(0); return true; }
}

export function makeFakeSpawn(): {
  spawn: ClaudeRunnerSpawn;
  lastCall: { args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeChildProcess } | null;
} {
  const state = { spawn: null as unknown as ClaudeRunnerSpawn, lastCall: null as any };
  state.spawn = ((command, args, opts) => {
    const child = new FakeChildProcess();
    state.lastCall = { args: args ?? [], env: opts?.env ?? {}, cwd: (opts?.cwd ?? '') as string, child };
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as ClaudeRunnerSpawn;
  return state;
}
