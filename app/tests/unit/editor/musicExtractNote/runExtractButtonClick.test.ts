import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const toastSpy = vi.fn();
vi.mock('$lib/stores/toast.js', () => ({ pushToast: (...a: unknown[]) => toastSpy(...a) }));
const extractSpy = vi.fn();
vi.mock('$lib/musicExtract/extractClient.js', async () => {
	const actual = await vi.importActual<typeof import('$lib/musicExtract/extractClient.js')>('$lib/musicExtract/extractClient.js');
	return { ...actual, extractOne: (...a: unknown[]) => extractSpy(...a) };
});
import { runExtractButtonClick } from '$lib/editor/musicExtractNote/runExtractButtonClick.js';
import { parseExtractNote } from '$lib/musicExtract/parseExtractNote.js';
import { ExtractError } from '$lib/musicExtract/extractClient.js';

const UUID = 'ab12cd34-5678-49ab-8cde-0123456789ab';
afterEach(() => { toastSpy.mockReset(); extractSpy.mockReset(); });

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
		expect(note.items[1].result).toMatchObject({ kind: 'done', title: 'Ok' });
		expect(note.items[2].result.kind).toBe('error');
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
		expect(note.items.every((i) => i.result.kind === 'pending')).toBe(true); // 노트에 에러 미기록
		ed.destroy();
	});
});
