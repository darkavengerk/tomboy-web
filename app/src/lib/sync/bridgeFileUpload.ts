/**
 * Client-side wrapper around bridge `POST /files`.
 *
 * Flow:
 *   uploadBridgeFile(file)
 *     1. read bridge URL + token from bridgeSettings
 *     2. validate (configured, non-empty, ≤ 50 MiB)
 *     3. fetch POST <httpBase>/files with raw body + X-Filename header
 *     4. return { uuid, filename, size, url }
 */

import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type BridgeFileUploadErrorKind =
	| 'bridge_not_configured'
	| 'empty_file'
	| 'too_large'
	| 'unauthorized'
	| 'network'
	| 'server';

export class BridgeFileUploadError extends Error {
	readonly kind: BridgeFileUploadErrorKind;
	constructor(kind: BridgeFileUploadErrorKind, message?: string) {
		super(message ?? kind);
		this.kind = kind;
	}
}

export interface BridgeFileUploadResult {
	uuid: string;
	filename: string;
	size: number;
	url: string;
}

export async function uploadBridgeFile(file: File): Promise<BridgeFileUploadResult> {
	const [bridge, token] = await Promise.all([
		getDefaultTerminalBridge(),
		getTerminalBridgeToken()
	]);
	if (!bridge || !token) {
		throw new BridgeFileUploadError(
			'bridge_not_configured',
			'브릿지 설정이 필요해요. 설정에서 URL과 토큰을 입력하세요.'
		);
	}
	if (file.size === 0) {
		throw new BridgeFileUploadError('empty_file', '빈 파일은 업로드할 수 없어요.');
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		throw new BridgeFileUploadError('too_large', '파일이 너무 커요 (50 MiB 한도).');
	}

	const httpBase = bridgeToHttpBase(bridge).replace(/\/$/, '');
	let res: Response;
	try {
		res = await fetch(`${httpBase}/files`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': file.type || 'application/octet-stream',
				'X-Filename': encodeURIComponent(file.name)
			},
			body: file
		});
	} catch (err) {
		throw new BridgeFileUploadError('network', (err as Error).message);
	}

	if (res.status === 401) {
		throw new BridgeFileUploadError(
			'unauthorized',
			'브릿지 토큰이 만료됐어요. 설정에서 다시 로그인하세요.'
		);
	}
	if (res.status === 413) {
		throw new BridgeFileUploadError('too_large', '파일이 너무 커요 (50 MiB 한도).');
	}
	if (!res.ok) {
		throw new BridgeFileUploadError('server', `브릿지 응답 오류 (${res.status})`);
	}

	const json = (await res.json()) as BridgeFileUploadResult;
	return json;
}
