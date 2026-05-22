import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { SshTarget } from './pty.js';

/** 전송된 이미지가 타깃 호스트에 놓이는 디렉터리. */
export const REMOTE_IMAGE_DIR = '/tmp/tomboy-images';

const MIME_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif'
};

/** 이미지 MIME → 확장자. 미지원이면 null. */
export function mimeToExt(mime: string): string | null {
	return MIME_EXT[mime] ?? null;
}

/**
 * 충돌 없고 셸-안전한 이미지 파일명을 만든다. 클라이언트가 보낸 원본 파일명은
 * 의도적으로 쓰지 않는다 — [a-z0-9-.]만 쓰는 고정 패턴이라 셸 메타문자가
 * 원격 명령에 닿지 않는다.
 */
export function safeImageName(ext: string): string {
	return `tomboy-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
}

/** TUI 앱이 "붙여넣기"로 인식하도록 bracketed-paste 마커로 감싼다. */
export function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/**
 * 이미지를 원격으로 흘려보내는 `ssh` 명령의 argv를 만든다. 이미지 바이트는
 * 자식 프로세스의 stdin으로 파이프되고, 원격 `cat`이 `remotePath`에 쓴다.
 * `controlPath`의 ControlMaster 연결을 재사용한다(재인증 없음).
 *
 * ControlMaster는 지정하지 않는다(기본 no) — 이 보조 연결은 마스터를 만들지
 * 않고 *사용*만 한다. `BatchMode=yes`라 마스터가 없으면 프롬프트 없이 즉시
 * 실패한다. `remotePath`의 파일명은 safeImageName() 산출물이라 셸 메타문자가
 * 없으므로 원격 명령에 그대로 끼워도 안전하다. 호스트는 명령보다 먼저 온다.
 */
export function buildRemoteCatArgs(
	t: SshTarget,
	controlPath: string,
	remotePath: string
): string[] {
	const args: string[] = [];
	if (t.port) args.push('-p', String(t.port));
	args.push('-o', 'StrictHostKeyChecking=accept-new');
	args.push('-o', 'BatchMode=yes');
	args.push('-o', `ControlPath=${controlPath}`);
	args.push(t.user ? `${t.user}@${t.host}` : t.host);
	args.push(`mkdir -p ${REMOTE_IMAGE_DIR} && cat > ${remotePath}`);
	return args;
}

export interface TransferRequest {
	target: SshTarget;
	/** ControlMaster 소켓 경로. null이면 로컬 셸 타깃 → 브릿지 fs에 직접 기록. */
	controlPath: string | null;
	mime: string;
	bytes: Buffer;
}

export interface TransferResult {
	remotePath: string;
}

/**
 * 이미지를 타깃 호스트 파일시스템에 놓고 경로를 반환한다.
 *  - 원격 타깃(controlPath 있음): 멀티플렉싱 ssh 연결로 바이트를 `cat`에 전송.
 *  - 로컬 셸 타깃(controlPath null): 브릿지 호스트가 곧 타깃 → 파일을 직접 기록.
 * 미지원 MIME / 전송 실패 시 throw.
 */
export async function transferImage(req: TransferRequest): Promise<TransferResult> {
	const ext = mimeToExt(req.mime);
	if (!ext) throw new Error(`지원하지 않는 이미지 형식입니다: ${req.mime}`);
	const remotePath = `${REMOTE_IMAGE_DIR}/${safeImageName(ext)}`;

	if (req.controlPath === null) {
		await mkdir(REMOTE_IMAGE_DIR, { recursive: true });
		await writeFile(remotePath, req.bytes);
		return { remotePath };
	}

	await streamToRemote(req.target, req.controlPath, remotePath, req.bytes);
	return { remotePath };
}

function streamToRemote(
	t: SshTarget,
	controlPath: string,
	remotePath: string,
	bytes: Buffer
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('ssh', buildRemoteCatArgs(t, controlPath, remotePath));
		let stderr = '';
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `ssh가 코드 ${code}로 종료됨`));
		});
		// 원격이 일찍 닫으면 stdin EPIPE — close 핸들러가 사유를 보고하므로 무시.
		child.stdin.on('error', () => { /* ignore */ });
		child.stdin.end(bytes);
	});
}
