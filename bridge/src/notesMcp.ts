// MCP Streamable HTTP 서버 (무상태 단건 JSON 응답 모드) — worklog 툴 4종.
// 클라 등록: claude mcp add --scope user --transport http worklog <base>/mcp \
//            --header "Authorization: Bearer <BRIDGE_SECRET>"
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readNotesCreds, createFirestoreNotesStore } from './notesStore.js';
import type { NotesStore } from './notesStore.js';
import {
	NotesOpError, notesAuthorized, readNoteOp, writeNoteOp, appendNoteOp, listNotesOp
} from './notes.js';

const PROTOCOL_FALLBACK = '2025-03-26';

const TOOLS = [
	{
		name: 'worklog_read',
		description: '톰보이 워크로그 노트를 마크다운으로 읽기. title 예: "[tomboy-web/shifu] 작업". 반환 changeDate는 다음 worklog_write의 ifChangeDate로 사용.',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string', description: '"[네임스페이스] 이름" 형식 정확 제목' } },
			required: ['title']
		}
	},
	{
		name: 'worklog_write',
		description: '워크로그 노트 업서트(마크다운 서브셋: ##헤딩/- 리스트/**bold**/`code`/[[내부링크]]/[x] 체크박스; 표·--- 금지). 기존 노트엔 ifChangeDate 필수 — conflict면 현재 본문이 반환되니 병합 후 재시도. force:true=무조건 덮어쓰기.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				markdown: { type: 'string' },
				ifChangeDate: { type: 'string' },
				force: { type: 'boolean' },
				createOnly: { type: 'boolean', description: 'true=노트가 이미 존재하면 conflict (생성 전용)' }
			},
			required: ['title', 'markdown']
		}
	},
	{
		name: 'worklog_list',
		description: '개발 노트북의 워크로그 노트 전체 목록 (title/guid/changeDate).',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'worklog_append',
		description: '노트 끝에 마크다운 블록 append (없으면 생성). "[프로젝트] 로그" append-only 노트용. 기존 본문도 md 서브셋으로 재직렬화됨(앱에서 넣은 서식 마크는 평문화).',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string' }, markdown: { type: 'string' } },
			required: ['title', 'markdown']
		}
	}
];

let _store: NotesStore | null = null;
function defaultStore(): NotesStore {
	return (_store ??= createFirestoreNotesStore());
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX) throw new Error('body too large');
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw) return {};
	return JSON.parse(raw);
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
	json(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}
function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
	json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function handleNotesMcp(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	if (!notesAuthorized(secret, req)) {
		json(res, 401, { error: 'unauthorized' });
		return;
	}
	let msg: Record<string, unknown>;
	try {
		msg = (await readJson(req)) as Record<string, unknown>;
	} catch {
		json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
		return;
	}
	if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
		json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
		return;
	}
	const id = msg.id;
	const method = typeof msg.method === 'string' ? msg.method : '';
	const params = (msg.params ?? {}) as Record<string, unknown>;

	if (method.startsWith('notifications/')) {
		res.writeHead(202);
		res.end();
		return;
	}
	if (method === 'initialize') {
		rpcResult(res, id, {
			protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: 'tomboy-worklog', version: '0.1.0' }
		});
		return;
	}
	if (method === 'ping') {
		rpcResult(res, id, {});
		return;
	}
	if (method === 'tools/list') {
		rpcResult(res, id, { tools: TOOLS });
		return;
	}
	if (method === 'tools/call') {
		const name = typeof params.name === 'string' ? params.name : '';
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		const creds = readNotesCreds();
		if (!creds) {
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify({ error: 'not_configured', detail: 'BRIDGE_NOTES_FILE 미설정' }) }], isError: true });
			return;
		}
		try {
			let result: unknown;
			if (name === 'worklog_read') result = await readNoteOp(creds, store, String(args.title ?? ''));
			else if (name === 'worklog_write')
				result = await writeNoteOp(creds, store, {
					title: String(args.title ?? ''),
					markdown: String(args.markdown ?? ''),
					ifChangeDate: typeof args.ifChangeDate === 'string' ? args.ifChangeDate : undefined,
					force: args.force === true,
					createOnly: args.createOnly === true
				});
			else if (name === 'worklog_append') result = await appendNoteOp(creds, store, String(args.title ?? ''), String(args.markdown ?? ''));
			else if (name === 'worklog_list') result = await listNotesOp(creds, store);
			else {
				rpcError(res, id, -32602, `unknown tool: ${name}`);
				return;
			}
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
		} catch (err) {
			if (err instanceof NotesOpError) {
				rpcResult(res, id, {
					content: [{ type: 'text', text: JSON.stringify({ error: err.code, detail: err.message, ...err.extra }, null, 1) }],
					isError: true
				});
				return;
			}
			console.error('[term-bridge] mcp tool failed:', err);
			rpcResult(res, id, { content: [{ type: 'text', text: JSON.stringify({ error: 'upstream_failed', detail: String(err) }) }], isError: true });
		}
		return;
	}
	rpcError(res, id, -32601, `method not found: ${method}`);
}
