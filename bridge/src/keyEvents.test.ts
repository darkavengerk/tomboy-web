import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_WHITELIST, isAllowedKeyCode, buildKeyCommand } from './keyEvents.js';

test('volume keys are whitelisted', () => {
	assert.equal(isAllowedKeyCode(24), true);
	assert.equal(isAllowedKeyCode(25), true);
});

test('non-whitelisted codes rejected', () => {
	assert.equal(isAllowedKeyCode(0), false);
	assert.equal(isAllowedKeyCode(26), false); // POWER — 의도적 미포함
	assert.equal(isAllowedKeyCode(99), false);
});

test('non-integers rejected', () => {
	assert.equal(isAllowedKeyCode('24'), false);
	assert.equal(isAllowedKeyCode(24.5), false);
	assert.equal(isAllowedKeyCode(-1), false);
	assert.equal(isAllowedKeyCode(null), false);
	assert.equal(isAllowedKeyCode(undefined), false);
	assert.equal(isAllowedKeyCode(NaN), false);
});

test('buildKeyCommand uses fixed su template', () => {
	assert.equal(buildKeyCommand(24), "su -c 'input keyevent 24'");
	assert.equal(buildKeyCommand(25), "su -c 'input keyevent 25'");
});

test('whitelist maps codes to readable names', () => {
	assert.equal(KEY_WHITELIST[24], 'VOLUME_UP');
	assert.equal(KEY_WHITELIST[25], 'VOLUME_DOWN');
});
