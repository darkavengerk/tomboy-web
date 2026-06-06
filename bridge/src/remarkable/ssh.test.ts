import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fetchMetadataDump, parseMetadataDump } from './ssh.js';

test('parseMetadataDump extracts uuid + fields per file', () => {
  const dump = [
    '===uuid-A.metadata===',
    JSON.stringify({ type: 'CollectionType', visibleName: 'Diary', parent: '' }),
    '===uuid-B.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: '2026-06-06', parent: 'uuid-A', lastModified: '1780740000000' }),
    '===uuid-C.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: 'other', parent: 'uuid-X' })
  ].join('\n');
  const out = parseMetadataDump(dump);
  assert.deepEqual(out.find((e) => e.uuid === 'uuid-A'), {
    uuid: 'uuid-A', type: 'CollectionType', visibleName: 'Diary', parent: '', lastModified: 0
  });
  assert.deepEqual(out.find((e) => e.uuid === 'uuid-B'), {
    uuid: 'uuid-B', type: 'DocumentType', visibleName: '2026-06-06', parent: 'uuid-A', lastModified: 1780740000000
  });
  assert.equal(out.length, 3);
});

test('parseMetadataDump skips malformed JSON without crashing', () => {
  const dump = [
    '===uuid-A.metadata===',
    '{"type":"DocumentType"',  // truncated
    '===uuid-B.metadata===',
    JSON.stringify({ type: 'DocumentType', visibleName: 'ok', parent: 'X' })
  ].join('\n');
  const out = parseMetadataDump(dump);
  assert.equal(out.length, 1);
  assert.equal(out[0].uuid, 'uuid-B');
});

test('fetchMetadataDump uses injected spawn and returns stdout', async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const { EventEmitter } = await import('node:events');
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child: any = new EventEmitter();
    child.stdout = Readable.from([Buffer.from('STDOUT-MARKER', 'utf8')]);
    child.stderr = Readable.from([]);
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as any;
  const out = await fetchMetadataDump(
    { host: 'rmrk.local', user: 'root', keyPath: '/tmp/key' },
    { spawn: fakeSpawn }
  );
  assert.equal(out, 'STDOUT-MARKER');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ssh');
  assert.ok(calls[0].args.includes('root@rmrk.local'));
});

test('runCapture rejects when stdout exceeds the cap', async () => {
  const { EventEmitter } = await import('node:events');
  // Use maxStdoutBytes=32 via fetchMetadataDump opts, emit 64 bytes
  const bigChunk = Buffer.alloc(64, 'x');
  const fakeSpawn = ((cmd: string, args: string[]) => {
    void cmd; void args;
    const child: any = new EventEmitter();
    child.stdout = Readable.from([bigChunk]);
    child.stderr = Readable.from([]);
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as any;
  await assert.rejects(
    () => fetchMetadataDump(
      { host: 'rmrk.local', user: 'root', keyPath: '/tmp/key' },
      { spawn: fakeSpawn, maxStdoutBytes: 32 }
    ),
    /stdout exceeded 32 bytes/
  );
});
