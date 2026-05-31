/**
 * Client wrapper for bridge `/files` admin endpoints (list + delete).
 */

import {
	getDefaultTerminalBridge,
	getTerminalBridgeToken,
	bridgeToHttpBase
} from '$lib/editor/terminal/bridgeSettings.js';

export interface BridgeFileMeta {
	uuid: string;
	filename: string;
	size: number;
	mtime: string;
}

async function authedBase(): Promise<{ base: string; token: string }> {
	const [bridge, token] = await Promise.all([
		getDefaultTerminalBridge(),
		getTerminalBridgeToken()
	]);
	if (!bridge || !token) {
		throw new Error('브릿지 설정이 필요해요.');
	}
	return { base: bridgeToHttpBase(bridge).replace(/\/$/, ''), token };
}

export async function listBridgeFiles(): Promise<BridgeFileMeta[]> {
	const { base, token } = await authedBase();
	const res = await fetch(`${base}/files`, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw new Error(`목록 조회 실패 (${res.status})`);
	return (await res.json()) as BridgeFileMeta[];
}

export async function deleteBridgeFile(uuid: string): Promise<void> {
	const { base, token } = await authedBase();
	const res = await fetch(`${base}/files/${encodeURIComponent(uuid)}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw new Error(`삭제 실패 (${res.status})`);
}
