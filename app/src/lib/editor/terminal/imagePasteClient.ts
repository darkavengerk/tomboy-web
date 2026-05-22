import { extractImageFile } from '$lib/editor/imagePreview/extractImageFile.js';

/** 허용 최대 이미지 크기 — 브릿지의 16 MB WS 한도 아래로 유지. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImagePayload {
	mime: string;
	/** base64 인코딩 이미지 바이트. data: URI 프리픽스 없음. */
	data: string;
}

export interface ValidationResult {
	ok: boolean;
	error?: string;
}

/** 후보 이미지 파일 검증 — image/* 타입 + 크기 한도. */
export function validateImageFile(file: File): ValidationResult {
	if (!file.type.startsWith('image/')) {
		return { ok: false, error: '이미지 파일이 아닙니다.' };
	}
	if (file.size > MAX_IMAGE_BYTES) {
		const mb = Math.floor(MAX_IMAGE_BYTES / 1024 / 1024);
		return { ok: false, error: `이미지가 너무 큽니다 (최대 ${mb} MB).` };
	}
	return { ok: true };
}

/** FileList / File[]에서 이미지 파일만 추린다 (드롭 + 파일선택 경로용). */
export function imageFilesFromList(files: FileList | File[]): File[] {
	return Array.from(files).filter((f) => f.type.startsWith('image/'));
}

/**
 * File을 ImagePayload(base64)로 읽는다. FileReader가 만드는 `data:...;base64,`
 * 프리픽스는 잘라내고 순수 base64 본문만 담는다.
 */
export function fileToImagePayload(file: File): Promise<ImagePayload> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
		reader.onload = () => {
			const result = String(reader.result);
			const comma = result.indexOf(',');
			if (comma < 0) {
				reject(new Error('파일을 읽지 못했습니다.'));
				return;
			}
			resolve({ mime: file.type, data: result.slice(comma + 1) });
		};
		reader.readAsDataURL(file);
	});
}

/** 재노출: paste/drop DataTransfer에서 이미지 File 하나를 뽑는다. */
export { extractImageFile };
