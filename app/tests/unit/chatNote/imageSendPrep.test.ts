import { describe, it, expect, vi } from 'vitest';
import {
	prepareImagesForSend,
	needsDownscale,
	DOWNSCALE_THRESHOLD_BYTES,
	type ImagePrepDeps
} from '$lib/chatNote/imageSendPrep.js';
import type { AnthropicMessage } from '$lib/chatNote/buildClaudeMessages.js';

function urlImageMsg(url: string, text = '이 이미지 읽어줘'): AnthropicMessage {
	return {
		role: 'user',
		content: [
			{ type: 'text', text },
			{ type: 'image', source: { type: 'url', url } }
		]
	};
}

function fakeBlob(bytes: number): Blob {
	return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
}

describe('needsDownscale', () => {
	it('임계 이하 false, 초과 true', () => {
		expect(needsDownscale(DOWNSCALE_THRESHOLD_BYTES)).toBe(false);
		expect(needsDownscale(DOWNSCALE_THRESHOLD_BYTES + 1)).toBe(true);
	});
});

describe('prepareImagesForSend', () => {
	it('임계 초과 이미지 → base64 블록으로 교체', async () => {
		const deps: ImagePrepDeps = {
			getBytes: vi.fn(async () => fakeBlob(DOWNSCALE_THRESHOLD_BYTES + 100)),
			downscale: vi.fn(async () => ({ data: 'QUJD', mediaType: 'image/jpeg' }))
		};
		const out = await prepareImagesForSend([urlImageMsg('https://x/temp-images/a.png')], deps);
		expect(out[0].content[1]).toEqual({
			type: 'image',
			source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' }
		});
		// 텍스트 블록은 그대로
		expect(out[0].content[0]).toEqual({ type: 'text', text: '이 이미지 읽어줘' });
	});

	it('임계 이하 이미지 → URL 블록 유지, downscale 호출 안 함', async () => {
		const downscale = vi.fn();
		const deps: ImagePrepDeps = {
			getBytes: vi.fn(async () => fakeBlob(1000)),
			downscale
		};
		const msg = urlImageMsg('https://x/temp-images/small.png');
		const out = await prepareImagesForSend([msg], deps);
		expect(out[0].content[1]).toEqual({
			type: 'image',
			source: { type: 'url', url: 'https://x/temp-images/small.png' }
		});
		expect(downscale).not.toHaveBeenCalled();
	});

	it('bytes 확보 실패 → URL 블록 유지 (서버 인라인 폴백)', async () => {
		const deps: ImagePrepDeps = {
			getBytes: vi.fn(async () => null),
			downscale: vi.fn()
		};
		const out = await prepareImagesForSend([urlImageMsg('https://x/a.png')], deps);
		expect(out[0].content[1]).toEqual({
			type: 'image',
			source: { type: 'url', url: 'https://x/a.png' }
		});
	});

	it('downscale 실패 → URL 블록 유지', async () => {
		const deps: ImagePrepDeps = {
			getBytes: vi.fn(async () => fakeBlob(DOWNSCALE_THRESHOLD_BYTES + 100)),
			downscale: vi.fn(async () => null)
		};
		const out = await prepareImagesForSend([urlImageMsg('https://x/a.png')], deps);
		expect(out[0].content[1]).toEqual({
			type: 'image',
			source: { type: 'url', url: 'https://x/a.png' }
		});
	});

	it('여러 메시지·여러 이미지 모두 순회, 원본 배열 비변형', async () => {
		const deps: ImagePrepDeps = {
			getBytes: vi.fn(async () => fakeBlob(DOWNSCALE_THRESHOLD_BYTES + 1)),
			downscale: vi.fn(async () => ({ data: 'RA==', mediaType: 'image/jpeg' }))
		};
		const input = [urlImageMsg('https://x/1.png'), urlImageMsg('https://x/2.png')];
		const out = await prepareImagesForSend(input, deps);
		expect(out[0].content[1]).toMatchObject({ source: { type: 'base64' } });
		expect(out[1].content[1]).toMatchObject({ source: { type: 'base64' } });
		// 입력 불변
		expect(input[0].content[1]).toEqual({
			type: 'image',
			source: { type: 'url', url: 'https://x/1.png' }
		});
	});

	it('이미지 없는 메시지는 그대로 통과', async () => {
		const getBytes = vi.fn();
		const deps: ImagePrepDeps = { getBytes, downscale: vi.fn() };
		const msgs: AnthropicMessage[] = [
			{ role: 'user', content: [{ type: 'text', text: '안녕' }] },
			{ role: 'assistant', content: [{ type: 'text', text: '네' }] }
		];
		const out = await prepareImagesForSend(msgs, deps);
		expect(out).toEqual(msgs);
		expect(getBytes).not.toHaveBeenCalled();
	});
});
