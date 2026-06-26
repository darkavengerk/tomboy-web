import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionList, coerceTarget } from './sessionList.js';

const TAB = '\t';
function row(parts: string[]): string { return parts.join(TAB); }

test('parseSessionList: single session, active pane command', () => {
	const out = [
		row(['claudesquad_fixauth', '2', '1', '1700000000', '1', '1', 'claude']),
		row(['claudesquad_fixauth', '2', '1', '1700000000', '0', '0', 'bash'])
	].join('\n');
	const sessions = parseSessionList(out);
	assert.equal(sessions.length, 1);
	assert.deepEqual(sessions[0], { name: 'claudesquad_fixauth', windows: 2, attached: true, activity: 1700000000, command: 'claude' });
});

test('parseSessionList: multiple sessions keep first-seen order', () => {
	const out = [ row(['main','3','1','10','1','1','vim']), row(['docs','1','0','20','1','1','bash']) ].join('\n');
	const sessions = parseSessionList(out);
	assert.deepEqual(sessions.map((s) => s.name), ['main', 'docs']);
	assert.equal(sessions[1].attached, false);
	assert.equal(sessions[1].command, 'bash');
});

test('parseSessionList: command only from active window+pane', () => {
	const out = [ row(['s','2','0','0','0','1','htop']), row(['s','2','0','0','1','0','less']), row(['s','2','0','0','1','1','claude']) ].join('\n');
	assert.equal(parseSessionList(out)[0].command, 'claude');
});

test('parseSessionList: malformed / short rows skipped', () => {
	const out = ['justname', 'a\tb\tc', '', row(['ok','1','1','0','1','1','sh'])].join('\n');
	assert.deepEqual(parseSessionList(out).map((s) => s.name), ['ok']);
});

test('parseSessionList: empty stdout → []', () => { assert.deepEqual(parseSessionList(''), []); });

test('parseSessionList: strips trailing CR', () => {
	const out = row(['s','1','1','0','1','1','sh']) + '\r';
	assert.equal(parseSessionList(out)[0].command, 'sh');
});

test('coerceTarget: valid host-only and full', () => {
	assert.deepEqual(coerceTarget({ host: 'desktop.lan' }), { host: 'desktop.lan', user: undefined, port: undefined });
	assert.deepEqual(coerceTarget({ user: 'you', host: '192.168.0.5', port: 2222 }), { user: 'you', host: '192.168.0.5', port: 2222 });
});

test('coerceTarget: rejects leading-dash host/user (ssh flag injection)', () => {
	assert.equal(coerceTarget({ host: '-oProxyCommand=evil' }), null);
	assert.equal(coerceTarget({ user: '-x', host: 'h' }), null);
});

test('coerceTarget: rejects bad chars and bad port', () => {
	assert.equal(coerceTarget({ host: 'a b' }), null);
	assert.equal(coerceTarget({ host: 'a/b' }), null);
	assert.equal(coerceTarget({ host: 'h', port: 70000 }), null);
	assert.equal(coerceTarget({ host: '' }), null);
	assert.equal(coerceTarget(null), null);
});
