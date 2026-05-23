import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panePosition } from './spectatorSession.js';

test('panePosition: active pane is the 2nd of 4', () => {
	const r = panePosition(['%1', '%2', '%3', '%4'], '%2');
	assert.deepEqual(r, { ordinal: 2, count: 4 });
});

test('panePosition: active pane id absent → ordinal 0, count kept', () => {
	const r = panePosition(['%1', '%2'], '%9');
	assert.deepEqual(r, { ordinal: 0, count: 2 });
});

test('panePosition: empty pane list → ordinal 0, count 0', () => {
	const r = panePosition([], '%1');
	assert.deepEqual(r, { ordinal: 0, count: 0 });
});

test('panePosition: first pane → ordinal 1', () => {
	const r = panePosition(['%7', '%8'], '%7');
	assert.deepEqual(r, { ordinal: 1, count: 2 });
});
