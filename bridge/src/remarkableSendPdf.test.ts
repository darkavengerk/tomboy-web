import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseSendPdfBody,
	processSendPdf,
	type SendPdfBody,
	type SendPdfDeps,
	type SseWriter
} from './remarkableSendPdf.js';
import type { RemarkableHost } from './remarkableHosts.js';

const HOST: RemarkableHost = { host: '10.0.0.42', user: 'root' };

function makeSse() {
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const sse: SseWriter = {
		status: (step, message) => events.push({ event: 'status', data: { step, message } }),
		error: (kind, message) => events.push({ event: 'error', data: { kind, message } }),
		done: (payload) => events.push({ event: 'done', data: payload })
	};
	return { sse, events };
}

function makeFake(over: Partial<SendPdfDeps> = {}) {
	const calls = {
		lookups: 0,
		pushed: [] as Array<{
			uuid: string;
			pdfLen: number;
			metadataJson: string;
			contentJson: string;
		}>,
		restarts: 0
	};
	const deps: SendPdfDeps = {
		hostsConfigured: () => true,
		resolveHost: () => HOST,
		lookupFolderUuid: async () => {
			calls.lookups += 1;
			return 'real-folder-uuid';
		},
		pushDocument: async (_h, uuid, pdfBytes, metadataJson, contentJson) => {
			calls.pushed.push({
				uuid,
				pdfLen: pdfBytes.length,
				metadataJson,
				contentJson
			});
		},
		restartXochitl: async () => {
			calls.restarts += 1;
		},
		...over
	};
	return { deps, calls };
}

const baseBody: SendPdfBody = {
	alias: 'rm2',
	folderName: 'Tomboy',
	folderUuid: 'client-cached-uuid',
	visibleName: '오늘 일기',
	pdfBase64: 'JVBERg=='
};

test('parseSendPdfBody: missing field → null', () => {
	assert.equal(parseSendPdfBody(null), null);
	assert.equal(parseSendPdfBody({ alias: 'rm2' }), null);
	assert.equal(
		parseSendPdfBody({ ...baseBody, pdfBase64: '' }),
		null
	);
});

test('parseSendPdfBody: trims string fields', () => {
	const p = parseSendPdfBody({ ...baseBody, alias: '  rm2  ', visibleName: ' x ' });
	assert.equal(p?.alias, 'rm2');
	assert.equal(p?.visibleName, 'x');
});

test('processSendPdf: emits folder_lookup → ssh_write → xochitl_reload → done', async () => {
	const { deps, calls } = makeFake();
	const { sse, events } = makeSse();
	const result = await processSendPdf(baseBody, HOST, deps, sse, () => 'fixed-doc-uuid', () => 1000);
	assert.equal(result.uuid, 'fixed-doc-uuid');
	assert.equal(result.folderUuid, 'real-folder-uuid');
	const steps = events
		.filter((e) => e.event === 'status')
		.map((e) => (e.data as { step: string }).step);
	assert.deepEqual(steps, ['folder_lookup', 'ssh_write', 'xochitl_reload']);
	assert.equal(events.at(-1)?.event, 'done');
	assert.equal(events.find((e) => e.event === 'error'), undefined);
	assert.equal(calls.lookups, 1);
	assert.equal(calls.pushed.length, 1);
	assert.equal(calls.restarts, 1);
});

test('processSendPdf: lookup returns null → unknown_folder error, no push', async () => {
	const { deps, calls } = makeFake({ lookupFolderUuid: async () => null });
	const { sse, events } = makeSse();
	await processSendPdf(baseBody, HOST, deps, sse);
	const err = events.find((e) => e.event === 'error');
	assert.ok(err);
	assert.equal((err!.data as { kind: string }).kind, 'unknown_folder');
	assert.equal(calls.pushed.length, 0);
	assert.equal(calls.restarts, 0);
});

test('processSendPdf: lookup throws → remote_failure error', async () => {
	const { deps } = makeFake({
		lookupFolderUuid: async () => {
			throw new Error('ssh exit 255');
		}
	});
	const { sse, events } = makeSse();
	await processSendPdf(baseBody, HOST, deps, sse);
	const err = events.find((e) => e.event === 'error');
	assert.ok(err);
	assert.equal((err!.data as { kind: string }).kind, 'remote_failure');
	assert.match((err!.data as { message: string }).message, /ssh exit 255/);
});

test('processSendPdf: pushDocument throws → remote_failure, restart NOT attempted', async () => {
	const { deps, calls } = makeFake({
		pushDocument: async () => {
			throw new Error('disk full');
		}
	});
	const { sse, events } = makeSse();
	await processSendPdf(baseBody, HOST, deps, sse);
	assert.equal(events.find((e) => e.event === 'error')?.data.kind, 'remote_failure');
	assert.equal(calls.restarts, 0);
});

test('processSendPdf: restartXochitl throws → still done (warn only)', async () => {
	const { deps, calls } = makeFake({
		restartXochitl: async () => {
			throw new Error('systemctl missing');
		}
	});
	const { sse, events } = makeSse();
	const result = await processSendPdf(baseBody, HOST, deps, sse);
	assert.ok(result.uuid);
	assert.equal(events.find((e) => e.event === 'done')?.event, 'done');
	assert.equal(events.find((e) => e.event === 'error'), undefined);
	assert.equal(calls.pushed.length, 1);
});

test('processSendPdf: uses bridge-resolved folderUuid even when client sent stale value', async () => {
	const { deps, calls } = makeFake({
		lookupFolderUuid: async () => 'real-uuid-from-bridge'
	});
	const { sse } = makeSse();
	await processSendPdf({ ...baseBody, folderUuid: 'stale-client-uuid' }, HOST, deps, sse);
	const md = JSON.parse(calls.pushed[0].metadataJson);
	assert.equal(md.parent, 'real-uuid-from-bridge');
});

test('processSendPdf: metadata + content JSON have required reMarkable fields', async () => {
	const { deps, calls } = makeFake();
	const { sse } = makeSse();
	await processSendPdf(baseBody, HOST, deps, sse, () => 'doc-uuid', () => 1737000000000);
	const md = JSON.parse(calls.pushed[0].metadataJson);
	assert.equal(md.type, 'DocumentType');
	assert.equal(md.parent, 'real-folder-uuid');
	assert.equal(md.visibleName, '오늘 일기');
	assert.equal(md.lastModified, '1737000000000');
	assert.equal(md.deleted, false);

	const ct = JSON.parse(calls.pushed[0].contentJson);
	assert.equal(ct.fileType, 'pdf');
	assert.equal(ct.formatVersion, 1);
});

test('processSendPdf: bad base64 decodes to empty → internal error', async () => {
	const { deps, calls } = makeFake();
	const { sse, events } = makeSse();
	await processSendPdf({ ...baseBody, pdfBase64: '!!!' }, HOST, deps, sse);
	// Buffer.from(garbage, 'base64') is permissive — produces empty for pure garbage.
	const err = events.find((e) => e.event === 'error');
	assert.equal(err?.data.kind, 'internal');
	assert.equal(calls.pushed.length, 0);
});
