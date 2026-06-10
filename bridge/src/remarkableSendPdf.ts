import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearer, verifyToken } from './auth.js';
import {
	lookupRemarkableHost,
	remarkableHostsConfigured,
	type RemarkableHost
} from './remarkableHosts.js';
import {
	parseFoldersFromRawMetadata,
	realFetchRawMetadata
} from './remarkableFolders.js';

/**
 * 노트 → reMarkable PDF 송출.
 *
 * 입력: JSON `{alias, folderName, folderUuid, visibleName, pdfBase64}`.
 * 출력: SSE 스트림 — folder_lookup → ssh_write → xochitl_reload → done|error.
 *
 * 흐름:
 * 1. 클라가 보낸 folderUuid 가 stale 일 수 있어 folderName 으로 항상 재확인.
 *    못 찾으면 unknown_folder.
 * 2. PDF 와 함께 `{uuid}.metadata` + `{uuid}.content` 한 SSH 세션으로 떨군다.
 * 3. systemctl restart xochitl. 재시작 실패는 PDF 자체는 이미 들어갔으므로 경고만
 *    찍고 done 처리 — 다음 reboot 시 reMarkable UI 에 노출된다.
 */

export interface SendPdfBody {
	alias: string;
	folderName: string;
	folderUuid: string;
	visibleName: string;
	pdfBase64: string;
}

export interface SendPdfDeps {
	hostsConfigured(): boolean;
	resolveHost(alias: string): RemarkableHost | null;
	/** folderName → uuid 재확인. null 이면 reMarkable 에 그 이름의 폴더 없음. */
	lookupFolderUuid(host: RemarkableHost, folderName: string): Promise<string | null>;
	pushDocument(
		host: RemarkableHost,
		uuid: string,
		pdfBytes: Buffer,
		metadataJson: string,
		contentJson: string
	): Promise<void>;
	restartXochitl(host: RemarkableHost): Promise<void>;
}

export interface SseWriter {
	status(step: string, message?: string): void;
	error(kind: string, message?: string): void;
	done(payload: Record<string, unknown>): void;
}

export interface ProcessSendPdfResult {
	uuid?: string;
	folderUuid?: string;
}

export async function processSendPdf(
	body: SendPdfBody,
	host: RemarkableHost,
	deps: SendPdfDeps,
	sse: SseWriter,
	makeUuid: () => string = () => randomUUID(),
	now: () => number = () => Date.now()
): Promise<ProcessSendPdfResult> {
	sse.status('folder_lookup');
	let folderUuid: string;
	try {
		const checked = await deps.lookupFolderUuid(host, body.folderName);
		if (!checked) {
			sse.error('unknown_folder', `폴더 '${body.folderName}' 가 리마커블에 없습니다`);
			return {};
		}
		folderUuid = checked;
	} catch (err) {
		sse.error('remote_failure', `폴더 조회 실패: ${(err as Error).message}`);
		return {};
	}

	let pdfBytes: Buffer;
	try {
		pdfBytes = Buffer.from(body.pdfBase64, 'base64');
		if (pdfBytes.length === 0) throw new Error('empty PDF');
	} catch (err) {
		sse.error('internal', `PDF decode 실패: ${(err as Error).message}`);
		return {};
	}

	const docUuid = makeUuid();
	const nowMs = now();
	const metadataJson = JSON.stringify({
		deleted: false,
		lastModified: String(nowMs),
		lastOpened: '0',
		lastOpenedPage: 0,
		metadatamodified: false,
		modified: false,
		parent: folderUuid,
		pinned: false,
		synced: false,
		type: 'DocumentType',
		version: 0,
		visibleName: body.visibleName
	});
	const contentJson = JSON.stringify({
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: 'pdf',
		fontName: '',
		formatVersion: 1,
		lineHeight: -1,
		margins: 100,
		orientation: 'portrait',
		originalPageCount: -1,
		pageCount: 0,
		pages: [],
		sizeInBytes: String(pdfBytes.length),
		textAlignment: 'left',
		textScale: 1,
		transform: {}
	});

	sse.status('ssh_write', `${docUuid}.pdf (${pdfBytes.length} bytes)`);
	try {
		await deps.pushDocument(host, docUuid, pdfBytes, metadataJson, contentJson);
	} catch (err) {
		sse.error('remote_failure', `파일 전송 실패: ${(err as Error).message}`);
		return {};
	}

	sse.status('xochitl_reload');
	try {
		await deps.restartXochitl(host);
	} catch (err) {
		// xochitl 재시작 실패는 PDF 자체는 떨궈진 상태라 done 처리. 다음 reboot 시
		// 표시됨. 사용자 모르게 두진 않고 stderr 로 흔적만 남긴다.
		console.warn(
			`[term-bridge rm send-pdf] xochitl restart failed: ${(err as Error).message}`
		);
	}

	sse.done({ uuid: docUuid, folderUuid, visibleName: body.visibleName });
	return { uuid: docUuid, folderUuid };
}

export function parseSendPdfBody(raw: unknown): SendPdfBody | null {
	if (!raw || typeof raw !== 'object') return null;
	const b = raw as Record<string, unknown>;
	const required = ['alias', 'folderName', 'folderUuid', 'visibleName', 'pdfBase64'] as const;
	for (const k of required) {
		if (typeof b[k] !== 'string' || !(b[k] as string).trim()) return null;
	}
	return {
		alias: (b.alias as string).trim(),
		folderName: (b.folderName as string).trim(),
		folderUuid: (b.folderUuid as string).trim(),
		visibleName: (b.visibleName as string).trim(),
		pdfBase64: b.pdfBase64 as string
	};
}

// ─── 실 SSH 의존성 ─────────────────────────────────────────────────

const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

async function realLookupFolderUuid(
	host: RemarkableHost,
	folderName: string
): Promise<string | null> {
	const raw = await realFetchRawMetadata(host);
	const folders = parseFoldersFromRawMetadata(raw);
	const target = folderName.trim();
	if (!target) return null;
	const hit = folders.find((f) => f.visibleName === target || f.path === target);
	return hit?.uuid ?? null;
}

function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

function runSshWithStdin(
	host: RemarkableHost,
	remoteCmd: string,
	stdin: Buffer | null
): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = [
			'-o', 'BatchMode=yes',
			'-o', 'StrictHostKeyChecking=accept-new',
			'-o', 'ConnectTimeout=8'
		];
		if (host.keyPath) args.push('-i', host.keyPath);
		if (host.port) args.push('-p', String(host.port));
		args.push(`${host.user}@${host.host}`, remoteCmd);
		const child = spawn('ssh', args, {
			stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe']
		});
		let stderr = '';
		child.stderr?.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', (err) => reject(err));
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ssh exit ${code}: ${stderr.trim().slice(0, 200)}`));
		});
		child.stdin?.on('error', () => {});
		if (stdin) child.stdin?.end(stdin);
	});
}

async function realPushDocument(
	host: RemarkableHost,
	uuid: string,
	pdfBytes: Buffer,
	metadataJson: string,
	contentJson: string
): Promise<void> {
	// 한 SSH 세션으로 3 파일 모두 떨군다. PDF 는 stdin (큰 바이너리), 짧은 JSON 둘은
	// here-doc 으로 안전하게 (single-quote escape). UUID 와 XOCHITL_DIR 는 hardcoded
	// / 우리가 생성한 값이라 셸 주입 위험 없음.
	const remoteCmd = [
		`cd '${XOCHITL_DIR}'`,
		`cat > '${uuid}.pdf'`,
		`printf '%s' '${shellEscape(metadataJson)}' > '${uuid}.metadata'`,
		`printf '%s' '${shellEscape(contentJson)}' > '${uuid}.content'`
	].join(' && ');
	await runSshWithStdin(host, remoteCmd, pdfBytes);
}

function realRestartXochitl(host: RemarkableHost): Promise<void> {
	return runSshWithStdin(host, 'systemctl restart xochitl', null);
}

export function realSendPdfDeps(): SendPdfDeps {
	return {
		hostsConfigured: remarkableHostsConfigured,
		resolveHost: lookupRemarkableHost,
		lookupFolderUuid: realLookupFolderUuid,
		pushDocument: realPushDocument,
		restartXochitl: realRestartXochitl
	};
}

// ─── HTTP 핸들러 ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > MAX_BODY_BYTES) throw new Error('body_too_large');
		chunks.push(buf);
	}
	if (total === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeSseWriter(res: ServerResponse): SseWriter {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive'
	});
	// 브릿지 전체에서 SSE flushHeaders 누락이 과거에 mode 마스킹 한 적 있어 명시.
	res.flushHeaders?.();
	function emit(event: string, data: unknown) {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	}
	return {
		status: (step, message) =>
			emit('status', message !== undefined ? { step, message } : { step }),
		error: (kind, message) =>
			emit('error', message !== undefined ? { kind, message } : { kind }),
		done: (payload) => emit('done', payload)
	};
}

export async function handleRemarkableSendPdf(
	req: IncomingMessage,
	res: ServerResponse,
	secret: string
): Promise<void> {
	const token = extractBearer(req.headers.authorization);
	if (!verifyToken(secret, token)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return;
	}
	if (!remarkableHostsConfigured()) {
		res.writeHead(503, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'remarkable_not_configured' }));
		return;
	}
	let raw: unknown;
	try {
		raw = await readJsonBody(req);
	} catch (err) {
		const msg = (err as Error).message === 'body_too_large' ? 'body_too_large' : 'bad_json';
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: msg }));
		return;
	}
	const body = parseSendPdfBody(raw);
	if (!body) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'bad_request' }));
		return;
	}
	const host = lookupRemarkableHost(body.alias);
	if (!host) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unknown_alias' }));
		return;
	}
	const sse = makeSseWriter(res);
	const result = await processSendPdf(body, host, realSendPdfDeps(), sse);
	console.log(
		`[term-bridge rm] send-pdf alias=${body.alias} folder=${body.folderName} ` +
			`uuid=${result.uuid ?? '-'}`
	);
	res.end();
}
