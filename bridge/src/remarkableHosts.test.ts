import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	loadRemarkableHosts,
	lookupRemarkableHost,
	remarkableHostsConfigured
} from './remarkableHosts.js';

function writeHosts(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'rmhosts-'));
	const path = join(dir, 'remarkable.json');
	writeFileSync(path, JSON.stringify(obj), 'utf8');
	return path;
}

test('loads a valid hosts file', () => {
	const path = writeHosts({ rm2: { host: '10.0.0.42', user: 'root', port: 22 } });
	loadRemarkableHosts(path);
	assert.equal(remarkableHostsConfigured(), true);
	const h = lookupRemarkableHost('rm2');
	assert.deepEqual(h, { host: '10.0.0.42', user: 'root', port: 22 });
});

test('defaults user to root when omitted', () => {
	const path = writeHosts({ rm2: { host: '10.0.0.42' } });
	loadRemarkableHosts(path);
	assert.equal(lookupRemarkableHost('rm2')!.user, 'root');
});

test('missing file → empty table, no throw', () => {
	loadRemarkableHosts('/nonexistent/path/remarkable.json');
	assert.equal(remarkableHostsConfigured(), false);
	assert.equal(lookupRemarkableHost('rm2'), null);
});

test('undefined path → empty table', () => {
	loadRemarkableHosts(undefined);
	assert.equal(remarkableHostsConfigured(), false);
});

test('invalid JSON → empty table, no throw', () => {
	const dir = mkdtempSync(join(tmpdir(), 'rmhosts-'));
	const path = join(dir, 'remarkable.json');
	writeFileSync(path, '{not json', 'utf8');
	loadRemarkableHosts(path);
	assert.equal(remarkableHostsConfigured(), false);
});

test('preserves keyPath when present, trimmed', () => {
	const path = writeHosts({ rm2: { host: '10.0.0.42', keyPath: ' /keys/rm.pem ' } });
	loadRemarkableHosts(path);
	assert.equal(lookupRemarkableHost('rm2')!.keyPath, '/keys/rm.pem');
});

test('entry without host is skipped', () => {
	const path = writeHosts({ good: { host: '1.2.3.4' }, bad: { user: 'root' } });
	loadRemarkableHosts(path);
	assert.notEqual(lookupRemarkableHost('good'), null);
	assert.equal(lookupRemarkableHost('bad'), null);
});
