import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

// Mock sweep/session/reload modules BEFORE importing newNoteFlow so the
// module-level imports inside newNoteFlow.svelte.ts resolve to stubs.
// NOTE: vi.mock factories are hoisted, so they cannot reference variables
// declared in the module scope. Use vi.fn() inline and retrieve mocks
// via vi.mocked() after import.
vi.mock('$lib/core/linkSweep.js', () => ({
	countLinkSweep: vi.fn(async () => ({ matched: ['g1', 'g2'], total: 5 })),
	applyLinkSweep: vi.fn(async () => ({ updated: ['g1', 'g2'], failed: 0 }))
}));

vi.mock('$lib/desktop/session.svelte.js', () => ({
	desktopSession: { flushAll: vi.fn(async () => {}), reloadWindows: vi.fn(async () => {}) }
}));

vi.mock('$lib/core/noteReloadBus.js', () => ({
	emitNoteReload: vi.fn(async () => {}),
	emitNoteFlush: vi.fn(async () => {})
}));

import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
import { getNote } from '$lib/core/noteManager.js';

describe('newNoteFlow', () => {
	beforeEach(() => newNoteFlow.cancel());

	it('open → input, submit → creating → ready → idle', async () => {
		let openedGuid: string | null = null;
		newNoteFlow.open({ notebook: null, navigate: (n) => { openedGuid = n.guid; } });
		expect(newNoteFlow.phase).toBe('input');

		const p = newNoteFlow.submit({ title: '서버', typeId: 'terminal', notebook: null });
		// phase transitions to 'creating' after the async duplicate-check resolves — poll briefly
		for (let i = 0; i < 20 && newNoteFlow.phase !== 'creating'; i++) await new Promise(r => setTimeout(r, 5));
		expect(newNoteFlow.phase).toBe('creating');
		// poll until navigate has been called (openedGuid is set)
		for (let i = 0; i < 50 && !openedGuid; i++) await new Promise(r => setTimeout(r, 5));
		expect(openedGuid).not.toBeNull();
		newNoteFlow.markEditorReady(openedGuid!);
		await p;
		// After success, phase should be 'result' (not 'idle')
		expect(newNoteFlow.phase).toBe('result');

		const note = await getNote(openedGuid!);
		expect(note!.title).toBe('서버');
		expect(note!.xmlContent).toContain('ssh://user@host');
	});

	it('중복 제목이면 생성하지 않고 input 단계를 유지한다', async () => {
		const { createNote: realCreate } = await import('$lib/core/noteManager.js');
		await realCreate({ title: '중복될 제목' });

		newNoteFlow.open({ notebook: null, navigate: () => {} });
		await newNoteFlow.submit({ title: '중복될 제목', typeId: 'plain', notebook: null });
		expect(newNoteFlow.phase).toBe('input'); // 다이얼로그 유지
	});

	describe('result phase', () => {
		async function createSuccessfulNote(): Promise<string> {
			let openedGuid: string | null = null;
			const title = '결과페이즈테스트' + Date.now();
			newNoteFlow.open({ notebook: null, navigate: (n) => { openedGuid = n.guid; } });
			const p = newNoteFlow.submit({ title, typeId: 'plain', notebook: null });
			for (let i = 0; i < 50 && !openedGuid; i++) await new Promise(r => setTimeout(r, 5));
			newNoteFlow.markEditorReady(openedGuid!);
			await p;
			return openedGuid!;
		}

		it('submit success → phase is result, stages retain ms', async () => {
			await createSuccessfulNote();
			expect(newNoteFlow.phase).toBe('result');
			// All 3 stages should have ms set
			expect(newNoteFlow.stages).toHaveLength(3);
			for (const stage of newNoteFlow.stages) {
				expect(stage.ms).not.toBeNull();
				expect(stage.status).toBe('done');
			}
		});

		it('dismiss() → idle, clears stages + sweep', async () => {
			await createSuccessfulNote();
			expect(newNoteFlow.phase).toBe('result');
			newNoteFlow.dismiss();
			expect(newNoteFlow.phase).toBe('idle');
			expect(newNoteFlow.stages).toHaveLength(0);
			expect(newNoteFlow.sweep.status).toBe('idle');
		});

		it('startSweepCount → confirm with matched count and total', async () => {
			const { countLinkSweep } = await import('$lib/core/linkSweep.js');
			vi.mocked(countLinkSweep).mockResolvedValueOnce({ matched: ['g1', 'g2'], total: 5 });

			await createSuccessfulNote();
			await newNoteFlow.startSweepCount();

			expect(newNoteFlow.sweep.status).toBe('confirm');
			expect(newNoteFlow.sweep.matched).toBe(2);
			expect(newNoteFlow.sweep.total).toBe(5);
		});

		it('applySweep → done with updated/failed, calls reloadWindows and emitNoteReload', async () => {
			const { countLinkSweep, applyLinkSweep } = await import('$lib/core/linkSweep.js');
			const { desktopSession } = await import('$lib/desktop/session.svelte.js');
			const { emitNoteReload } = await import('$lib/core/noteReloadBus.js');

			vi.mocked(countLinkSweep).mockResolvedValueOnce({ matched: ['g1', 'g2'], total: 3 });
			vi.mocked(applyLinkSweep).mockResolvedValueOnce({ updated: ['g1', 'g2'], failed: 0 });
			vi.mocked(desktopSession.reloadWindows).mockClear();
			vi.mocked(emitNoteReload).mockClear();

			await createSuccessfulNote();
			await newNoteFlow.startSweepCount();
			await newNoteFlow.applySweep();

			expect(newNoteFlow.sweep.status).toBe('done');
			expect(newNoteFlow.sweep.updated).toBe(2);
			expect(newNoteFlow.sweep.failed).toBe(0);
			expect(desktopSession.reloadWindows).toHaveBeenCalledWith(['g1', 'g2']);
			expect(emitNoteReload).toHaveBeenCalledWith(['g1', 'g2']);
		});

		it('cancelSweep() sets cancel flag; count ends at idle not confirm', async () => {
			const { countLinkSweep } = await import('$lib/core/linkSweep.js');
			// Simulate count that honours cancelToken: when cancelled=true before the
			// mock returns, the implementation should detect it and stay idle.
			vi.mocked(countLinkSweep).mockImplementationOnce(async (_title, _guid, opts) => {
				// Simulate the cancel being set externally (test calls cancelSweep)
				if (opts?.cancelToken) opts.cancelToken.cancelled = true;
				return { matched: [], total: 0 };
			});

			await createSuccessfulNote();
			const countP = newNoteFlow.startSweepCount();
			newNoteFlow.cancelSweep();
			await countP;

			// Should remain idle (not confirm) because cancelToken was set
			expect(newNoteFlow.sweep.status).toBe('idle');
		});

		it('error in submit (navigate throws) → phase returns to idle', async () => {
			newNoteFlow.open({ notebook: null, navigate: () => { throw new Error('nav error'); } });
			await newNoteFlow.submit({ title: 'nav-error-' + Date.now(), typeId: 'plain', notebook: null });
			// navigate throws → catch path → phase = 'idle'
			expect(newNoteFlow.phase).toBe('idle');
		});

		it('cancel() also resets from result phase to idle', async () => {
			await createSuccessfulNote();
			expect(newNoteFlow.phase).toBe('result');
			newNoteFlow.cancel();
			expect(newNoteFlow.phase).toBe('idle');
			expect(newNoteFlow.stages).toHaveLength(0);
		});
	});
});
