import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { readHueCreds, writeHueCreds, clearHueCreds, fileHueCredsStore } from './hueCreds.js';

// 각 테스트는 고유 임시 경로를 BRIDGE_HUE_FILE 로 지정한다. hueCreds 는 호출마다
// process.env 를 다시 읽으므로(캐시 없음) 테스트 간 간섭이 없다.
function withFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'huecreds-'));
  return join(dir, name);
}
function setEnv(p: string | undefined) {
  if (p === undefined) delete process.env.BRIDGE_HUE_FILE;
  else process.env.BRIDGE_HUE_FILE = p;
}

test('env 미설정: read null / write throw / clear no-op', () => {
  setEnv(undefined);
  assert.equal(readHueCreds(), null);
  assert.throws(() => writeHueCreds({ ip: '1.2.3.4', appkey: 'A', clientkey: 'C' }));
  assert.doesNotThrow(() => clearHueCreds());
});

test('write→read 라운드트립 + perms 0600', () => {
  const p = withFile('hue.json'); setEnv(p);
  writeHueCreds({ ip: '192.168.0.50', appkey: 'APPKEY', clientkey: 'CK' });
  assert.deepEqual(readHueCreds(), { ip: '192.168.0.50', appkey: 'APPKEY', clientkey: 'CK' });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('손상 JSON → null', () => {
  const p = withFile('bad.json'); setEnv(p);
  writeFileSync(p, '{ not json');
  assert.equal(readHueCreds(), null);
});

test('필드 누락(appkey 빈값) → null', () => {
  const p = withFile('partial.json'); setEnv(p);
  writeFileSync(p, JSON.stringify({ ip: '1.2.3.4', appkey: '', clientkey: '' }), { mode: 0o600 });
  assert.equal(readHueCreds(), null);
});

test('clear 후 read null; 없는 파일 clear 예외 없음', () => {
  const p = withFile('hue.json'); setEnv(p);
  writeHueCreds({ ip: '1.2.3.4', appkey: 'A', clientkey: '' });
  clearHueCreds();
  assert.equal(existsSync(p), false);
  assert.equal(readHueCreds(), null);
  assert.doesNotThrow(() => clearHueCreds());
});

test('fileHueCredsStore 위임', () => {
  const p = withFile('hue.json'); setEnv(p);
  fileHueCredsStore.write({ ip: '10.0.0.1', appkey: 'K', clientkey: '' });
  assert.equal(fileHueCredsStore.read()?.ip, '10.0.0.1');
  fileHueCredsStore.clear();
  assert.equal(fileHueCredsStore.read(), null);
});
