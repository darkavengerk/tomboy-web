// 워크로그 노트 API — 코어 op + HTTP 핸들러.
// 가드: 제목 /^\[[^\]\r\n]+\] [^\r\n]+$/ AND 문서 tags에 system:notebook:{notebook}.
// rename 없음(백링크 캐스케이드는 앱측 전용). 충돌은 changeDate 낙관적 잠금.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken, extractBearer, passwordMatches } from './auth.js';
import {
	readNotesCreds, createFirestoreNotesStore, formatTomboyDate, newGuid
} from './notesStore.js';
import type { NotesCreds, NotesStore, NoteDoc } from './notesStore.js';
import { mdToNoteContent, noteContentToMd } from './noteMarkdown.js';

// ---- 에러 모델 ----
type OpCode = 'not_configured' | 'forbidden_title' | 'forbidden_notebook' | 'not_found' | 'conflict' | 'bad_request';

export class NotesOpError extends Error {
	constructor(
		public code: OpCode,
		message: string,
		public extra?: Record<string, unknown>
	) {
		super(message);
	}
}

const CODE_TO_STATUS: Record<OpCode, number> = {
	not_configured: 503,
	forbidden_title: 403,
	forbidden_notebook: 403,
	not_found: 404,
	conflict: 409,
	bad_request: 400
};

// ---- 가드 ----
const TITLE_RE = /^\[[^\]\r\n]+\] [^\r\n]+$/;

function notebookTag(creds: NotesCreds): string {
	return `system:notebook:${creds.notebook}`;
}
function guardTitle(title: string): void {
	if (!TITLE_RE.test(title)) throw new NotesOpError('forbidden_title', '제목은 "[네임스페이스] 이름" 형식이어야 함');
}
function guardDoc(creds: NotesCreds, doc: NoteDoc): void {
	if (!doc.tags.includes(notebookTag(creds))) throw new NotesOpError('forbidden_notebook', `노트가 ${creds.notebook} 노트북 밖`);
}

// ---- 코어 op (MCP에서도 재사용) ----
export interface ReadResult {
	guid: string;
	title: string;
	changeDate: string;
	markdown: string;
}
export interface WriteInput {
	title: string;
	markdown: string;
	ifChangeDate?: string;
	force?: boolean;
	createOnly?: boolean;
}
export interface WriteResult {
	guid: string;
	changeDate: string;
	created: boolean;
}

export async function readNoteOp(creds: NotesCreds, store: NotesStore, title: string): Promise<ReadResult> {
	const t = title.trim();
	guardTitle(t);
	const doc = await store.findByTitle(creds, t);
	if (!doc || doc.deleted) throw new NotesOpError('not_found', '노트 없음');
	guardDoc(creds, doc);
	return { guid: doc.guid, title: doc.title, changeDate: doc.changeDate, markdown: noteContentToMd(doc.xmlContent).markdown };
}

export async function writeNoteOp(creds: NotesCreds, store: NotesStore, input: WriteInput): Promise<WriteResult> {
	const title = input.title.trim();
	guardTitle(title);
	const existing = await store.findByTitle(creds, title);
	const now = formatTomboyDate();
	if (existing && !existing.deleted) {
		guardDoc(creds, existing);
		const conflictExtra = () => ({
			changeDate: existing.changeDate,
			markdown: noteContentToMd(existing.xmlContent).markdown
		});
		if (input.createOnly) throw new NotesOpError('conflict', '노트가 이미 존재', conflictExtra());
		if (!input.force) {
			if (!input.ifChangeDate) throw new NotesOpError('conflict', '기존 노트 갱신엔 ifChangeDate 필요 (read 후 재시도)', conflictExtra());
			if (input.ifChangeDate !== existing.changeDate) throw new NotesOpError('conflict', 'changeDate 불일치 — 원격이 더 최신', conflictExtra());
		}
		const doc: NoteDoc = {
			...existing,
			title,
			// 왕복 재직렬화 — 서식 마크 평문화 (append 주석 참고)
			xmlContent: mdToNoteContent(title, input.markdown),
			changeDate: now,
			metadataChangeDate: now,
			deleted: false
		};
		await store.write(creds, doc);
		return { guid: doc.guid, changeDate: now, created: false };
	}
	// 신규 또는 톰스톤 부활(guid 재사용 — 제목 중복 방지). 타 노트북 톰스톤은 거부.
	if (existing?.deleted && existing.tags.length > 0 && !existing.tags.includes(notebookTag(creds))) {
		throw new NotesOpError('forbidden_notebook', '타 노트북의 삭제 노트 제목');
	}
	const guid = existing?.guid ?? newGuid();
	const doc: NoteDoc = {
		guid,
		uri: `note://tomboy/${guid}`,
		title,
		xmlContent: mdToNoteContent(title, input.markdown),
		createDate: existing?.createDate || now,
		changeDate: now,
		metadataChangeDate: now,
		tags: [notebookTag(creds)],
		deleted: false,
		public: false
	};
	await store.write(creds, doc);
	return { guid, changeDate: now, created: true };
}

// append도 전체 본문을 md 왕복 재직렬화 — 앱에서 추가한 서식 마크(datetime/italic/size 등)는 텍스트만 남고 평문화됨 (md 서브셋 의도)
export async function appendNoteOp(creds: NotesCreds, store: NotesStore, title: string, markdown: string): Promise<WriteResult> {
	const t = title.trim();
	guardTitle(t);
	const existing = await store.findByTitle(creds, t);
	if (!existing || existing.deleted) return writeNoteOp(creds, store, { title: t, markdown });
	guardDoc(creds, existing);
	const cur = noteContentToMd(existing.xmlContent).markdown;
	const merged = cur.trim() ? `${cur}\n\n${markdown}` : markdown;
	return writeNoteOp(creds, store, { title: t, markdown: merged, ifChangeDate: existing.changeDate });
}

export async function listNotesOp(creds: NotesCreds, store: NotesStore): Promise<{ notes: Array<{ title: string; guid: string; changeDate: string }> }> {
	const docs = await store.listByNotebook(creds);
	return {
		notes: docs
			.filter((d) => !d.deleted && TITLE_RE.test(d.title))
			.map((d) => ({ title: d.title, guid: d.guid, changeDate: d.changeDate }))
			.sort((a, b) => a.title.localeCompare(b.title))
	};
}

// ---- HTTP 배선 ----
let _store: NotesStore | null = null;
function defaultStore(): NotesStore {
	return (_store ??= createFirestoreNotesStore());
}

/** 민트 토큰 OR 원시 시크릿(constant-time) — MCP 고정 헤더/스크립트가 30일 만료에 안 걸리게. */
export function notesAuthorized(secret: string, req: IncomingMessage): boolean {
	const token = extractBearer(req.headers.authorization);
	if (!token) return false;
	return verifyToken(secret, token) || passwordMatches(token, secret);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	const MAX = 1024 * 1024; // 노트 본문 1 MiB 상한
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

async function runHandler(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string,
	fn: (creds: NotesCreds, body: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
	if (!notesAuthorized(secret, req)) {
		json(res, 401, { error: 'unauthorized' });
		return;
	}
	const creds = readNotesCreds();
	if (!creds) {
		json(res, 503, { error: 'not_configured', detail: 'BRIDGE_NOTES_FILE 미설정' });
		return;
	}
	let body: Record<string, unknown>;
	try {
		body = (await readJson(req)) as Record<string, unknown>;
	} catch {
		json(res, 400, { error: 'bad_json' });
		return;
	}
	try {
		json(res, 200, await fn(creds, body));
	} catch (err) {
		if (err instanceof NotesOpError) {
			json(res, CODE_TO_STATUS[err.code], { error: err.code, detail: err.message, ...err.extra });
			return;
		}
		console.error('[term-bridge] notes op failed:', err);
		json(res, 502, { error: 'upstream_failed', detail: err instanceof Error ? err.message : String(err) });
	}
}

function requireString(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	if (typeof v !== 'string' || !v) throw new NotesOpError('bad_request', `missing_${key}`);
	return v;
}

export async function handleNotesRead(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) => readNoteOp(creds, store, requireString(body, 'title')));
}

export async function handleNotesWrite(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) =>
		writeNoteOp(creds, store, {
			title: requireString(body, 'title'),
			markdown: typeof body.markdown === 'string' ? body.markdown : '',
			ifChangeDate: typeof body.ifChangeDate === 'string' ? body.ifChangeDate : undefined,
			force: body.force === true,
			createOnly: body.createOnly === true
		})
	);
}

export async function handleNotesAppend(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds, body) =>
		appendNoteOp(creds, store, requireString(body, 'title'), requireString(body, 'markdown'))
	);
}

export async function handleNotesList(req: IncomingMessage, res: ServerResponse, secret: string, store: NotesStore = defaultStore()): Promise<void> {
	await runHandler(req, res, secret, (creds) => listNotesOp(creds, store));
}
