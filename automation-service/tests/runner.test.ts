import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runEntries } from '../src/runner.js';
import type { CommandEntry } from '../src/registry.js';

// Fake child process: emits the configured stdout then closes with `code`.
function fakeChild(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable; stderr: Readable; kill: () => void;
  };
  child.stdout = Readable.from([Buffer.from(stdout, 'utf8')]);
  child.stderr = Readable.from([]);
  child.kill = () => {};
  // close after the stdout has been consumed on next tick
  setImmediate(() => child.emit('close', code));
  return child;
}

function fakeSpawn(map: Record<string, { stdout: string; code: number }>) {
  // key by the 3rd arg (repo path) so two entries differ
  return ((_cmd: string, args: string[]) => {
    const key = args[1] ?? '';
    const cfg = map[key] ?? { stdout: '', code: 0 };
    return fakeChild(cfg.stdout, cfg.code);
  }) as unknown as typeof import('node:child_process').spawn;
}

const ENTRIES: CommandEntry[] = [
  { project: 'tomboy', exec: ['python3', 'loc.py', '/repoA', '--csv-only'] },
  { project: 'robotC', exec: ['python3', 'loc.py', '/repoB', '--csv-only'] }
];

describe('runEntries', () => {
  it('collects stdout per project on success', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: 'a,b\n1,2\n', code: 0 }, '/repoB': { stdout: 'c\n3\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn });
    expect(out.results).toEqual({ tomboy: 'a,b\n1,2\n', robotC: 'c\n3\n' });
    expect(out.errors).toEqual({});
  });

  it('records errors for non-zero exit but keeps other projects', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: '', code: 1 }, '/repoB': { stdout: 'ok\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn });
    expect(out.results).toEqual({ robotC: 'ok\n' });
    expect(Object.keys(out.errors)).toEqual(['tomboy']);
  });

  it('errors a project whose output exceeds the size cap', async () => {
    const spawn = fakeSpawn({ '/repoA': { stdout: 'x'.repeat(100), code: 0 }, '/repoB': { stdout: 'ok\n', code: 0 } });
    const out = await runEntries(ENTRIES, { spawn, maxOutputBytes: 10 });
    expect(out.results).toEqual({ robotC: 'ok\n' });
    expect(out.errors.tomboy).toMatch(/너무 큽/);
  });
});
