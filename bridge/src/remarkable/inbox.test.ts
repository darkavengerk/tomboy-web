import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInboxIndex, updateInboxIndex, diffNewUuids } from './inbox.js';

test('readInboxIndex returns {} when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  assert.deepEqual(readInboxIndex(`${dir}/state`), {});
});

test('readInboxIndex parses existing index.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const stateDir = `${dir}/state`;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    `${stateDir}/index.json`,
    JSON.stringify({ 'u1': { present: true, mtime: 100, received_at: '2026-06-06T01:00:00' } })
  );
  const idx = readInboxIndex(stateDir);
  assert.equal(idx['u1'].mtime, 100);
});

test('diffNewUuids returns uuids not in index', () => {
  const idx = { u1: { present: true, mtime: 1, received_at: 'x' } };
  assert.deepEqual(diffNewUuids(['u1', 'u2', 'u3'], idx), ['u2', 'u3']);
});

test('updateInboxIndex merges new entries and persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'));
  const stateDir = `${dir}/state`;
  updateInboxIndex(stateDir, {
    'u1': { present: true, mtime: 1780667129000, received_at: '2026-06-06T01:00:00' }
  });
  const persisted = JSON.parse(readFileSync(`${stateDir}/index.json`, 'utf8'));
  assert.equal(persisted.u1.mtime, 1780667129000);
});
