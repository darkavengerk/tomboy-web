import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const toastSpy = vi.fn();
vi.mock('$lib/stores/toast.js', () => ({ pushToast: (...a: unknown[]) => toastSpy(...a) }));
const extractSpy = vi.fn();
const enumSpy = vi.fn();
vi.mock('$lib/musicExtract/extractClient.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/musicExtract/extractClient.js')>('$lib/musicExtract/extractClient.js');
	return { ...actual, extractOne: (...a: unknown[]) => extractSpy(...a), enumeratePlaylist: (...a: unknown[]) => enumSpy(...a) };
});
import { runExtractButtonClick } from '$lib/editor/musicExtractNote/runExtractButtonClick.js';
import { parseExtractNote, type SingleItem } from '$lib/musicExtract/parseExtractNote.js';
import { ExtractError } from '$lib/musicExtract/extractClient.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
afterEach(() => { toastSpy.mockReset(); extractSpy.mockReset(); enumSpy.mockReset(); });

describe('runExtractButtonClick', () => {
	it('대기 항목만 순차 추출하고 결과를 기록한다', async () => {
		const ed = new Editor({
			extensions: [StarterKit],
			content: `<p>음악추출::x</p><ul>
				<li><p>https://yt/done</p><ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li>
				<li><p>https://yt/ok</p></li>
				<li><p>https://yt/bad</p></li></ul>`
		});
		extractSpy.mockImplementation(async ({ source }: { source: string }) => {
			if (source === 'https://yt/ok') return { url: `https://b.ex/files/${UUID}/Ok.mp3`, title: 'Ok' };
			throw new ExtractError('upstream_error', 'x');
		});
		await runExtractButtonClick(ed.view);
		expect(extractSpy).toHaveBeenCalledTimes(2);
		const note = parseExtractNote(ed.state.doc);
		expect((note.items[1] as SingleItem).result).toMatchObject({ kind: 'done', title: 'Ok' });
		expect((note.items[2] as SingleItem).result.kind).toBe('error');
		expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('1곡 추출'), expect.anything());
		ed.destroy();
	});

	it('대기 0건이면 안내 토스트', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><ul><li><p>https://yt/d</p><ul><li><p>https://b.ex/files/${UUID}/D.mp3</p></li></ul></li></ul>` });
		await runExtractButtonClick(ed.view);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(toastSpy).toHaveBeenCalledWith('추출할 항목이 없습니다', expect.anything());
		ed.destroy();
	});

	it('전체(항목별) 실패 시 error 토스트', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><ul><li><p>https://yt/a</p></li><li><p>https://yt/b</p></li></ul>` });
		extractSpy.mockRejectedValue(new ExtractError('upstream_error', 'x'));
		await runExtractButtonClick(ed.view);
		expect(extractSpy).toHaveBeenCalledTimes(2);
		expect(toastSpy).toHaveBeenCalledWith('2곡 실패', { kind: 'error' });
		ed.destroy();
	});

	it('시스템 오류는 도배 없이 토스트+중단', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><ul><li><p>https://yt/a</p></li><li><p>https://yt/b</p></li></ul>` });
		extractSpy.mockRejectedValue(new ExtractError('not_configured', 'x'));
		await runExtractButtonClick(ed.view);
		expect(extractSpy).toHaveBeenCalledTimes(1); // 첫 항목에서 중단
		expect(toastSpy).toHaveBeenCalledWith('브릿지 설정이 필요합니다', { kind: 'error' });
		const note = parseExtractNote(ed.state.doc);
		expect(note.items.every((i) => i.kind === 'single' && i.result.kind === 'pending')).toBe(true); // 노트에 에러 미기록
		ed.destroy();
	});

	it('재생목록: 열거→곡별 추출→블록 삽입 + 요약 토스트', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockResolvedValue({ label: '가수A', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false });
		extractSpy.mockImplementation(async ({ source }: { source: string }) => ({ url: `https://b.ex/files/${UUID}/${source.endsWith('1') ? 'A' : 'B'}.mp3`, title: 'x' }));
		await runExtractButtonClick(ed.view);
		expect(enumSpy).toHaveBeenCalledTimes(1);
		expect(extractSpy).toHaveBeenCalledTimes(2);
		const note = parseExtractNote(ed.state.doc);
		const pl = note.items.find((i) => i.kind === 'playlist');
		expect(pl && pl.kind === 'playlist' && pl.done).toBe(true);
		expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('재생목록 1개(2곡)'), expect.anything());
		ed.destroy();
	});

	it('재생목록 부분 실패: 성공곡만 블록, 토스트 표기', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }, { url: 'https://yt/2', title: 'b' }], total: 2, truncated: false });
		extractSpy.mockImplementation(async ({ source }: { source: string }) => {
			if (source === 'https://yt/2') throw new ExtractError('upstream_error', 'x');
			return { url: `https://b.ex/files/${UUID}/A.mp3`, title: 'a' };
		});
		await runExtractButtonClick(ed.view);
		expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('재생목록 1개(1곡)'), expect.anything());
		ed.destroy();
	});

	it('재생목록 systemic 열거 실패 → 토스트+중단(곡 추출 없음)', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockRejectedValue(new ExtractError('not_configured', 'x'));
		await runExtractButtonClick(ed.view);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(toastSpy).toHaveBeenCalledWith('브릿지 설정이 필요합니다', { kind: 'error' });
		ed.destroy();
	});

	it('재생목록 잘림 → 상한 초과 경고', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 80, truncated: true });
		extractSpy.mockResolvedValue({ url: `https://b.ex/files/${UUID}/A.mp3`, title: 'a' });
		await runExtractButtonClick(ed.view);
		expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('상한 초과'), expect.anything());
		ed.destroy();
	});

	it('재생목록 비-systemic 열거 실패 → 토스트+계속(곡 추출 없음)', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockRejectedValue(new ExtractError('bad_request', 'x'));
		await runExtractButtonClick(ed.view);
		expect(extractSpy).not.toHaveBeenCalled();
		expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('재생목록 열거 실패'), expect.anything());
		ed.destroy();
	});

	it('재생목록 전곡 실패 + 잘림 → 블록 미작성, 상한 경고 없음', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p>` });
		enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 80, truncated: true });
		extractSpy.mockRejectedValue(new ExtractError('upstream_error', 'x'));
		await runExtractButtonClick(ed.view);
		const note = parseExtractNote(ed.state.doc);
		expect(note.items.some((i) => i.kind === 'playlist' && i.done)).toBe(false); // 블록 미작성
		expect(toastSpy).toHaveBeenCalledWith('변경 없음', expect.anything());
		expect(toastSpy).not.toHaveBeenCalledWith(expect.stringContaining('상한 초과'), expect.anything());
		ed.destroy();
	});

	it('단일+재생목록 혼합 — 둘 다 처리, 요약에 합산', async () => {
		const ed = new Editor({ extensions: [StarterKit], content: `<p>음악추출::x</p><p>https://www.youtube.com/watch?v=v1&list=PLa</p><ul><li><p>https://yt/single</p></li></ul>` });
		enumSpy.mockResolvedValue({ label: 'L', entries: [{ url: 'https://yt/1', title: 'a' }], total: 1, truncated: false });
		extractSpy.mockResolvedValue({ url: `https://b.ex/files/${UUID}/A.mp3`, title: 'a' });
		await runExtractButtonClick(ed.view);
		expect(enumSpy).toHaveBeenCalledTimes(1);
		// single 1곡 + 재생목록 1곡 = extractOne 2회
		expect(extractSpy).toHaveBeenCalledTimes(2);
		expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/재생목록 1개\(1곡\).*1곡 추출|1곡 추출.*재생목록 1개\(1곡\)/), expect.anything());
		ed.destroy();
	});
});
