import { getDB } from '$lib/storage/db.js';

/**
 * NanumGothic Regular/Bold 를 lazy 하게 받아 pdfmake 인스턴스의 vfs 와 fonts
 * 패밀리에 등록한다.
 *
 * 출처: `/fonts/NanumGothic-*.ttf` (빌드 시 `scripts/prefetch-fonts.mjs` 가
 * `static/fonts/` 에 채워준다).
 *
 * 첫 호출은 fetch → IDB(`appSettings` store 의 `font:*` 키) 캐시 → 메모리. 두
 * 번째 호출부터는 IDB hit. 같은 세션에서 동시 호출이 들어와도 한 번만 받는다.
 */

const FONT_FILES = {
	'NanumGothic-Regular.ttf': '/fonts/NanumGothic-Regular.ttf',
	'NanumGothic-Bold.ttf': '/fonts/NanumGothic-Bold.ttf'
} as const;

type FontName = keyof typeof FONT_FILES;

const CACHE_KEY_PREFIX = 'font:';

export type KoreanFontBytes = Record<FontName, Uint8Array>;

interface PdfmakeLike {
	vfs?: Record<string, string>;
	fonts?: Record<string, unknown>;
}

let cached: KoreanFontBytes | null = null;
let pending: Promise<KoreanFontBytes> | null = null;

export async function loadKoreanFonts(): Promise<KoreanFontBytes> {
	if (cached) return cached;
	if (pending) return pending;
	pending = (async () => {
		const out = {} as KoreanFontBytes;
		for (const name of Object.keys(FONT_FILES) as FontName[]) {
			out[name] = await loadOne(name, FONT_FILES[name]);
		}
		cached = out;
		pending = null;
		return out;
	})();
	return pending;
}

async function loadOne(name: FontName, url: string): Promise<Uint8Array> {
	const hit = await readCache(name);
	if (hit) return hit;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(
			`한글 폰트(${name}) 로드 실패: HTTP ${resp.status}. ` +
				`'npm run prefetch:fonts' 를 한 번 실행하면 빌드에 폰트가 들어갑니다.`
		);
	}
	const bytes = new Uint8Array(await resp.arrayBuffer());
	await writeCache(name, bytes);
	return bytes;
}

async function readCache(name: FontName): Promise<Uint8Array | null> {
	try {
		const db = await getDB();
		const row = (await db.get('appSettings', `${CACHE_KEY_PREFIX}${name}`)) as
			| { id: string; value: { bytes: Uint8Array | ArrayBuffer } }
			| undefined;
		if (!row?.value?.bytes) return null;
		// IDB 는 ArrayBuffer / typed array 둘 다 그대로 돌려준다 — 둘 다 받아준다.
		return row.value.bytes instanceof Uint8Array
			? row.value.bytes
			: new Uint8Array(row.value.bytes);
	} catch {
		return null;
	}
}

async function writeCache(name: FontName, bytes: Uint8Array): Promise<void> {
	try {
		const db = await getDB();
		await db.put('appSettings', {
			id: `${CACHE_KEY_PREFIX}${name}`,
			value: { bytes }
		});
	} catch {
		// 캐시 실패는 무시 — 다음 송출 시 fetch 다시 함.
	}
}

/**
 * pdfmake 인스턴스에 한글 폰트 패밀리 'Korean' 을 등록한다. `pdfBundle` 의
 * `defaultStyle.font` 가 'Korean' 을 가리키므로 송출 직전에 호출해야 한다.
 */
export function registerKoreanFontFamily(pdfmake: PdfmakeLike, fonts: KoreanFontBytes): void {
	if (!pdfmake.vfs) pdfmake.vfs = {};
	const vfs = pdfmake.vfs;
	for (const [name, bytes] of Object.entries(fonts) as Array<[FontName, Uint8Array]>) {
		vfs[name] = bytesToBase64(bytes);
	}
	pdfmake.fonts = {
		...(pdfmake.fonts ?? {}),
		Korean: {
			normal: 'NanumGothic-Regular.ttf',
			bold: 'NanumGothic-Bold.ttf',
			italics: 'NanumGothic-Regular.ttf',
			bolditalics: 'NanumGothic-Bold.ttf'
		}
	};
}

function bytesToBase64(bytes: Uint8Array): string {
	// String.fromCharCode 의 인수 상한(스택 보호) 우회: 32KB 청크로 끊어서 변환.
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const slice = bytes.subarray(i, i + CHUNK);
		binary += String.fromCharCode.apply(null, slice as unknown as number[]);
	}
	return btoa(binary);
}

/** 테스트 / 핫리로드 용 — 내부 메모리 캐시 비우기. IDB 는 안 건드린다. */
export function _resetKoreanFontCacheForTests(): void {
	cached = null;
	pending = null;
}
