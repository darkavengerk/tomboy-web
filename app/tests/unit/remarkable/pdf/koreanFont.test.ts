import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	loadKoreanFonts,
	registerKoreanFontFamily,
	_resetKoreanFontCacheForTests
} from '$lib/remarkable/pdf/koreanFont.js';
import { _resetDBForTest } from '$lib/storage/db.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	_resetDBForTest();
	_resetKoreanFontCacheForTests();
});
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.clearAllMocks();
});

function mkFetchOk(byteFor: (url: string) => Uint8Array): typeof fetch {
	return vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input.toString();
		const bytes = byteFor(url);
		// BodyInit 의 좁은 ArrayBuffer 추론을 우회하려고 새 ArrayBuffer 로 복사.
		const ab = new ArrayBuffer(bytes.length);
		new Uint8Array(ab).set(bytes);
		return new Response(ab, { status: 200 });
	}) as unknown as typeof fetch;
}

describe('loadKoreanFonts', () => {
	it('fetches both NanumGothic files on first call', async () => {
		const fetchMock = mkFetchOk((url) => {
			if (url.endsWith('Regular.ttf')) return new Uint8Array([1, 2, 3]);
			if (url.endsWith('Bold.ttf')) return new Uint8Array([4, 5, 6]);
			throw new Error(`unexpected url ${url}`);
		});
		globalThis.fetch = fetchMock;
		const fonts = await loadKoreanFonts();
		expect(Array.from(fonts['NanumGothic-Regular.ttf'])).toEqual([1, 2, 3]);
		expect(Array.from(fonts['NanumGothic-Bold.ttf'])).toEqual([4, 5, 6]);
		expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	it('returns the same in-memory result on second call without re-fetching', async () => {
		const fetchMock = mkFetchOk(() => new Uint8Array([9]));
		globalThis.fetch = fetchMock;
		await loadKoreanFonts();
		await loadKoreanFonts();
		// 2 files × 1 fetch each = 2 total. Memory hit on the second call.
		expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	it('two concurrent calls share a single in-flight fetch', async () => {
		const fetchMock = mkFetchOk(() => new Uint8Array([7]));
		globalThis.fetch = fetchMock;
		const [a, b] = await Promise.all([loadKoreanFonts(), loadKoreanFonts()]);
		expect(a).toBe(b);
		expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	it('subsequent session (memory cleared) hits IDB instead of network', async () => {
		const fetchMock = mkFetchOk((url) =>
			new Uint8Array([url.endsWith('Bold.ttf') ? 22 : 11])
		);
		globalThis.fetch = fetchMock;
		await loadKoreanFonts();
		expect((fetchMock as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

		// 새 세션 시뮬레이션: 메모리만 비우고 IDB 유지.
		_resetKoreanFontCacheForTests();
		const blowupFetch = vi.fn(() => {
			throw new Error('network must not be called when IDB has the font');
		}) as unknown as typeof fetch;
		globalThis.fetch = blowupFetch;

		const fonts = await loadKoreanFonts();
		expect(Array.from(fonts['NanumGothic-Regular.ttf'])).toEqual([11]);
		expect(Array.from(fonts['NanumGothic-Bold.ttf'])).toEqual([22]);
	});

	it('throws a Korean error message on HTTP failure', async () => {
		globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
		await expect(loadKoreanFonts()).rejects.toThrow(/한글 폰트.*HTTP 404/);
	});
});

describe('registerKoreanFontFamily', () => {
	it('populates pdfmake.vfs with base64 bytes + fonts.Korean family', () => {
		const fonts = {
			'NanumGothic-Regular.ttf': new Uint8Array([0x48, 0x69]), // "Hi"
			'NanumGothic-Bold.ttf': new Uint8Array([0x42, 0x6f, 0x6c, 0x64]) // "Bold"
		};
		const pdfmake: { vfs?: Record<string, string>; fonts?: Record<string, unknown> } = {};
		registerKoreanFontFamily(pdfmake, fonts);
		expect(pdfmake.vfs!['NanumGothic-Regular.ttf']).toBe('SGk=');
		expect(pdfmake.vfs!['NanumGothic-Bold.ttf']).toBe('Qm9sZA==');
		expect(pdfmake.fonts!.Korean).toEqual({
			normal: 'NanumGothic-Regular.ttf',
			bold: 'NanumGothic-Bold.ttf',
			italics: 'NanumGothic-Regular.ttf',
			bolditalics: 'NanumGothic-Bold.ttf'
		});
	});

	it('preserves existing vfs entries and font families', () => {
		const fonts = {
			'NanumGothic-Regular.ttf': new Uint8Array([0]),
			'NanumGothic-Bold.ttf': new Uint8Array([0])
		};
		const pdfmake: { vfs: Record<string, string>; fonts: Record<string, unknown> } = {
			vfs: { 'Other.ttf': 'preserved' },
			fonts: { Roboto: { normal: 'Roboto.ttf' } }
		};
		registerKoreanFontFamily(pdfmake, fonts);
		expect(pdfmake.vfs['Other.ttf']).toBe('preserved');
		expect(pdfmake.fonts.Roboto).toBeDefined();
		expect(pdfmake.fonts.Korean).toBeDefined();
	});
});
