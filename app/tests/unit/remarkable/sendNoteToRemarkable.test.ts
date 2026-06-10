import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEmptyNote, escapeXml, type NoteData } from '$lib/core/note.js';

vi.mock('$lib/editor/terminal/bridgeSettings.js', () => ({
	getDefaultTerminalBridge: vi.fn(),
	getTerminalBridgeToken: vi.fn(),
	bridgeToHttpBase: (b: string) => `https://${b.replace(/^wss?:\/\//, '')}`
}));

import {
	sendNoteToRemarkable,
	SendRemarkableError
} from '$lib/remarkable/sendNoteToRemarkable.js';
import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken
} from '$lib/editor/terminal/bridgeSettings.js';

function makeNote(guid: string, title: string, body = ''): NoteData {
	const n = createEmptyNote(guid);
	n.title = title;
	n.xmlContent = `<note-content version="0.1">${escapeXml(title)}\n\n${body}\n</note-content>`;
	return n;
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const f of frames) controller.enqueue(enc.encode(f));
			controller.close();
		}
	});
}

const realFetch = globalThis.fetch;
const fakePdfBlob = () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' });

beforeEach(() => {
	(getDefaultTerminalBridge as ReturnType<typeof vi.fn>).mockResolvedValue('wss://host/ws');
	(getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');
});
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.clearAllMocks();
});

const basicOpts = (extras: Partial<Parameters<typeof sendNoteToRemarkable>[0]> = {}) => ({
	rootGuid: 'g1',
	notes: [makeNote('g1', 'Root', 'body')],
	alias: 'rm2',
	folderName: 'Tomboy',
	folderUuid: 'folder-uuid',
	forwardDepth: 0, backwardDepth: 0,
	buildPdf: async () => fakePdfBlob(),
	...extras
});

describe('sendNoteToRemarkable', () => {
	it('throws not_configured when bridge or token missing', async () => {
		(getTerminalBridgeToken as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'not_configured'
		});
	});

	it('throws not_configured when folder is missing', async () => {
		await expect(
			sendNoteToRemarkable(basicOpts({ folderUuid: '' }))
		).rejects.toMatchObject({ kind: 'not_configured' });
	});

	it('POSTs a JSON body with base64 PDF + all metadata fields', async () => {
		let bodyText = '';
		let contentType = '';
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			bodyText = typeof init?.body === 'string' ? init.body : '';
			contentType =
				(init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? '';
			return new Response(sseBody(['event: done\ndata: {}\n\n']), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}) as typeof fetch;

		const result = await sendNoteToRemarkable(basicOpts());
		expect(result.visibleName).toBe('Root');
		expect(result.includedGuids).toEqual(['g1']);
		expect(result.pdfSizeBytes).toBe(4);
		expect(contentType).toBe('application/json');
		const parsed = JSON.parse(bodyText);
		expect(parsed.alias).toBe('rm2');
		expect(parsed.folderName).toBe('Tomboy');
		expect(parsed.folderUuid).toBe('folder-uuid');
		expect(parsed.visibleName).toBe('Root');
		expect(parsed.pdfBase64).toBe('JVBERg=='); // %PDF
	});

	it('emits status events: building_pdf, uploading, then server stream', async () => {
		const statuses: unknown[] = [];
		globalThis.fetch = (async () =>
			new Response(
				sseBody([
					'event: status\ndata: {"step":"folder_lookup"}\n\n',
					'event: status\ndata: {"step":"ssh_write"}\n\n',
					'event: done\ndata: {}\n\n'
				]),
				{ status: 200, headers: { 'content-type': 'text/event-stream' } }
			)) as typeof fetch;

		await sendNoteToRemarkable(basicOpts({ onStatus: (s) => statuses.push(s) }));
		const steps = statuses.map((s) => (s as { step: string }).step);
		expect(steps).toEqual(['building_pdf', 'uploading', 'folder_lookup', 'ssh_write']);
	});

	it('maps 401 to unauthorized', async () => {
		globalThis.fetch = (async () =>
			new Response('{"error":"unauthorized"}', {
				status: 401,
				headers: { 'content-type': 'application/json' }
			})) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'unauthorized'
		});
	});

	it('maps {error: "unknown_alias"} body to unknown_alias kind', async () => {
		globalThis.fetch = (async () =>
			new Response('{"error":"unknown_alias"}', {
				status: 400,
				headers: { 'content-type': 'application/json' }
			})) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'unknown_alias'
		});
	});

	it('maps {error: "unknown_folder"} body to unknown_folder kind', async () => {
		globalThis.fetch = (async () =>
			new Response('{"error":"unknown_folder"}', {
				status: 400,
				headers: { 'content-type': 'application/json' }
			})) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'unknown_folder'
		});
	});

	it('maps 5xx to remote_failure', async () => {
		globalThis.fetch = (async () =>
			new Response('{"error":"ssh_failed"}', {
				status: 502,
				headers: { 'content-type': 'application/json' }
			})) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'remote_failure',
			detail: 'ssh_failed'
		});
	});

	it('throws on stream error event with kind preserved', async () => {
		globalThis.fetch = (async () =>
			new Response(
				sseBody(['event: error\ndata: {"kind":"unknown_folder","message":"잘못된 폴더"}\n\n']),
				{ status: 200, headers: { 'content-type': 'text/event-stream' } }
			)) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'unknown_folder',
			detail: '잘못된 폴더'
		});
	});

	it('aborts mid-stream → network/aborted', async () => {
		const ac = new AbortController();
		const enc = new TextEncoder();
		const paused = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode('event: status\ndata: {"step":"folder_lookup"}\n\n'));
				// 이후 close 안 함 — 외부에서 abort 한다.
			}
		});
		globalThis.fetch = (async () =>
			new Response(paused, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			})) as typeof fetch;
		const p = sendNoteToRemarkable(basicOpts({ signal: ac.signal }));
		await Promise.resolve();
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: 'network', detail: 'aborted' });
	});

	it("stream ends without done → internal error", async () => {
		globalThis.fetch = (async () =>
			new Response(sseBody(['event: status\ndata: {"step":"folder_lookup"}\n\n']), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			})) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'internal'
		});
	});

	it('network failure → network kind', async () => {
		globalThis.fetch = (async () => {
			throw new Error('ECONNREFUSED');
		}) as typeof fetch;
		await expect(sendNoteToRemarkable(basicOpts())).rejects.toMatchObject({
			kind: 'network',
			detail: 'ECONNREFUSED'
		});
	});
});

describe('SendRemarkableError', () => {
	it('exposes kind + detail', () => {
		const e = new SendRemarkableError('unknown_folder', 'x');
		expect(e.kind).toBe('unknown_folder');
		expect(e.detail).toBe('x');
		expect(e.message).toBe('unknown_folder: x');
	});
});
