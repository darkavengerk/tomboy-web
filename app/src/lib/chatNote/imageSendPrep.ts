import type { AnthropicMessage, ContentBlock } from './buildClaudeMessages.js';
import { getBlob, lookupOrFetch } from '$lib/imageCache/imageCache.js';

/**
 * 전송 전 이미지 다운스케일 — 큰 이미지를 base64로 인라인해서 보낸다.
 *
 * 배경: 이미지 URL 블록은 claude-service(Pi)가 서버측에서 fetch해 base64로
 * 인라인하는데, 8MiB 캡이 있고 Anthropic API 자체도 이미지당 5MB 제한이다.
 * 폰 사진(클립보드 PNG 재인코딩 시 20MB+)은 항상 실패했다. 임계 초과
 * 이미지는 클라이언트에서 긴 변 1568px JPEG로 줄여 base64 블록으로 교체 —
 * Pi의 fetch 의존(임시 blob 수명·네트워크)도 함께 제거된다.
 *
 * 임계 이하 이미지는 URL 블록 유지(브릿지 body 2MiB 캡에 안 걸리게 payload
 * 최소화). bytes 확보/다운스케일 실패 시엔 URL 블록 그대로 — 서버 인라인이
 * 폴백으로 동작한다.
 */

/** 이 크기(bytes) 초과 시 다운스케일. Anthropic 5MB 제한에 여유 마진. */
export const DOWNSCALE_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** 다운스케일 목표 긴 변(px). Anthropic vision 권장 최대. */
export const MAX_DIMENSION = 1568;

const JPEG_QUALITY = 0.85;

export interface ImagePrepDeps {
	/** URL → 이미지 bytes. null이면 확보 실패(URL 블록 유지). */
	getBytes: (url: string) => Promise<Blob | null>;
	/** 원본 → 축소 JPEG base64. null이면 실패(URL 블록 유지). */
	downscale: (blob: Blob) => Promise<{ data: string; mediaType: string } | null>;
}

export function needsDownscale(bytes: number): boolean {
	return bytes > DOWNSCALE_THRESHOLD_BYTES;
}

/** 캐시 우선 bytes 확보 — 미스 시 lookupOrFetch(fetcher 체인: Dropbox SDK/plain fetch)로 채운 뒤 재조회. */
async function defaultGetBytes(url: string): Promise<Blob | null> {
	try {
		const cached = await getBlob(url);
		if (cached) return cached;
		await lookupOrFetch(url);
		return await getBlob(url);
	} catch {
		return null;
	}
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/** canvas로 긴 변 MAX_DIMENSION 제한 + JPEG 재인코딩. 디코드 불가(SVG 등)면 null. */
async function defaultDownscale(blob: Blob): Promise<{ data: string; mediaType: string } | null> {
	try {
		const bmp = await createImageBitmap(blob);
		try {
			const scale = Math.min(1, MAX_DIMENSION / Math.max(bmp.width, bmp.height));
			const w = Math.max(1, Math.round(bmp.width * scale));
			const h = Math.max(1, Math.round(bmp.height * scale));
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.drawImage(bmp, 0, 0, w, h);
			const out = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
			);
			if (!out) return null;
			return { data: await blobToBase64(out), mediaType: 'image/jpeg' };
		} finally {
			bmp.close();
		}
	} catch {
		return null;
	}
}

const DEFAULT_DEPS: ImagePrepDeps = {
	getBytes: defaultGetBytes,
	downscale: defaultDownscale
};

async function prepBlock(block: ContentBlock, deps: ImagePrepDeps): Promise<ContentBlock> {
	if (block.type !== 'image' || block.source.type !== 'url') return block;
	const bytes = await deps.getBytes(block.source.url);
	if (!bytes || !needsDownscale(bytes.size)) return block;
	const scaled = await deps.downscale(bytes);
	if (!scaled) return block;
	return {
		type: 'image',
		source: { type: 'base64', media_type: scaled.mediaType, data: scaled.data }
	};
}

/** 메시지 배열의 모든 이미지 URL 블록을 검사·교체한 새 배열 반환(입력 비변형). */
export async function prepareImagesForSend(
	messages: AnthropicMessage[],
	deps: ImagePrepDeps = DEFAULT_DEPS
): Promise<AnthropicMessage[]> {
	return Promise.all(
		messages.map(async (m) => {
			if (!m.content.some((b) => b.type === 'image' && b.source.type === 'url')) return m;
			return {
				...m,
				content: await Promise.all(m.content.map((b) => prepBlock(b, deps)))
			};
		})
	);
}
