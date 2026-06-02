import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { buildServer } from '../src/server.js';
import { parseRegistry } from '../src/registry.js';

const TOKEN = 'shared-secret';
const REGISTRY = parseRegistry(
  JSON.stringify({ commands: { 'loc-history': [{ project: 'tomboy', exec: ['echo', 'x', '/repo'] }] } })
);

function fakeSpawn() {
  return ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
    child.stdout = Readable.from([Buffer.from('a,b\n1,2\n', 'utf8')]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

function app() {
  return buildServer({ sharedToken: TOKEN, registry: REGISTRY, runnerOpts: { spawn: fakeSpawn() } });
}

describe('POST /run', () => {
  it('401 without Bearer', async () => {
    const res = await app().inject({ method: 'POST', url: '/run', payload: { command: 'loc-history' } });
    expect(res.statusCode).toBe(401);
  });

  it('400 when command missing', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: {}
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 unknown_command for unregistered id', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { command: 'nope' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_command');
  });

  it('200 with results on success', async () => {
    const res = await app().inject({
      method: 'POST', url: '/run',
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { command: 'loc-history' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: { tomboy: 'a,b\n1,2\n' }, errors: {} });
  });
});
