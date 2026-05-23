import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	mimeToExt,
	safeImageName,
	bracketedPaste,
	buildRemoteCatArgs,
	REMOTE_IMAGE_DIR
} from './imageTransfer.js';

test('mimeToExt: known image types', () => {
	assert.equal(mimeToExt('image/png'), 'png');
	assert.equal(mimeToExt('image/jpeg'), 'jpg');
	assert.equal(mimeToExt('image/webp'), 'webp');
	assert.equal(mimeToExt('image/gif'), 'gif');
});

test('mimeToExt: unsupported type → null', () => {
	assert.equal(mimeToExt('image/svg+xml'), null);
	assert.equal(mimeToExt('text/plain'), null);
});

test('safeImageName: matches safe pattern with given ext', () => {
	assert.match(safeImageName('png'), /^tomboy-\d+-[0-9a-f]{8}\.png$/);
});

test('safeImageName: two calls differ', () => {
	assert.notEqual(safeImageName('png'), safeImageName('png'));
});

test('bracketedPaste: wraps in paste markers', () => {
	assert.equal(bracketedPaste('/tmp/x.png'), '\x1b[200~/tmp/x.png\x1b[201~');
});

test('buildRemoteCatArgs: BatchMode + ControlPath + cat command, host before command', () => {
	const remotePath = `${REMOTE_IMAGE_DIR}/tomboy-1-aabbccdd.png`;
	const args = buildRemoteCatArgs(
		{ host: 'h', user: 'u' },
		'/tmp/tomboy-ctl/abc.sock',
		remotePath
	);
	assert.ok(args.includes('BatchMode=yes'));
	assert.ok(args.includes('ControlPath=/tmp/tomboy-ctl/abc.sock'));
	assert.equal(args[args.length - 2], 'u@h');
	assert.equal(
		args[args.length - 1],
		`mkdir -p ${REMOTE_IMAGE_DIR} && cat > ${remotePath}`
	);
});

test('buildRemoteCatArgs: includes port when set', () => {
	const args = buildRemoteCatArgs(
		{ host: 'h', user: 'u', port: 2222 },
		'/s.sock',
		`${REMOTE_IMAGE_DIR}/x.png`
	);
	const pIdx = args.indexOf('-p');
	assert.ok(pIdx >= 0);
	assert.equal(args[pIdx + 1], '2222');
});
