import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSshHosts, lookupSshHost, applySshAlias } from './sshHosts.js';

function writeHosts(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'sshhosts-'));
	const path = join(dir, 'ssh-hosts.json');
	writeFileSync(path, JSON.stringify(obj), 'utf8');
	return path;
}

test('loads a valid alias', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	assert.deepEqual(lookupSshHost('phone'), { host: 'localhost', user: 'termux', port: 18022 });
});

test('missing file → empty table, no throw', () => {
	loadSshHosts('/nonexistent/ssh-hosts.json');
	assert.equal(lookupSshHost('phone'), null);
});

test('undefined path → empty table', () => {
	loadSshHosts(undefined);
	assert.equal(lookupSshHost('phone'), null);
});

test('entry without host is skipped', () => {
	const path = writeHosts({ bad: { user: 'x' }, phone: { host: 'localhost' } });
	loadSshHosts(path);
	assert.equal(lookupSshHost('bad'), null);
	assert.equal(lookupSshHost('phone')!.host, 'localhost');
});

test('applySshAlias resolves a bare alias target', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	const { target, alias } = applySshAlias({ host: 'phone' });
	assert.equal(alias, 'phone');
	assert.deepEqual(target, { host: 'localhost', port: 18022, user: 'termux' });
});

test('applySshAlias preserves note-specified user and port', () => {
	const path = writeHosts({ phone: { host: 'localhost', user: 'termux', port: 18022 } });
	loadSshHosts(path);
	const { target } = applySshAlias({ host: 'phone', user: 'me', port: 9999 });
	assert.deepEqual(target, { host: 'localhost', port: 9999, user: 'me' });
});

test('applySshAlias leaves non-alias targets untouched', () => {
	loadSshHosts(undefined);
	const { target, alias } = applySshAlias({ host: 'example.com', user: 'bob', port: 22 });
	assert.equal(alias, null);
	assert.deepEqual(target, { host: 'example.com', user: 'bob', port: 22 });
});

test('applySshAlias with bare-host alias leaves user/port undefined', () => {
	const path = writeHosts({ box: { host: '10.0.0.5' } });
	loadSshHosts(path);
	const { target, alias } = applySshAlias({ host: 'box' });
	assert.equal(alias, 'box');
	assert.deepEqual(target, { host: '10.0.0.5', port: undefined, user: undefined });
});

test('invalid JSON → empty table, no throw', () => {
	const dir = mkdtempSync(join(tmpdir(), 'sshhosts-'));
	const path = join(dir, 'ssh-hosts.json');
	writeFileSync(path, '{not json', 'utf8');
	loadSshHosts(path);
	assert.equal(lookupSshHost('phone'), null);
});

test('out-of-range port is dropped from entry', () => {
	const path = writeHosts({ a: { host: 'h', port: 0 }, b: { host: 'h2', port: 70000 } });
	loadSshHosts(path);
	assert.equal(lookupSshHost('a')!.port, undefined);
	assert.equal(lookupSshHost('b')!.port, undefined);
});
