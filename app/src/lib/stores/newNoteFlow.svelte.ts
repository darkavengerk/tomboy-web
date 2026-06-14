import type { NoteData } from '$lib/core/note.js';
import { createNote } from '$lib/core/noteManager.js';
import { ensureTitleIndexReady } from '$lib/editor/autoLink/titleProvider.js';
import { ensureBacklinkIndexReady } from '$lib/core/backlinkIndex.js';
import { composeTitle, bodyFirstLine } from '$lib/noteTypes/registry.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { pushToast } from '$lib/stores/toast.js';
import { countLinkSweep, applyLinkSweep } from '$lib/core/linkSweep.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';

export interface Stage {
	name: string;
	ms: number | null;
	status: 'pending' | 'active' | 'done';
}

export interface SweepState {
	status: 'idle' | 'counting' | 'confirm' | 'applying' | 'done';
	scanned: number;
	total: number;
	matched: number;
	updated: number;
	failed: number;
	ms: number;
}

type NavigateFn = (note: NoteData) => void | Promise<void>;

function emptySweep(): SweepState {
	return { status: 'idle', scanned: 0, total: 0, matched: 0, updated: 0, failed: 0, ms: 0 };
}

let phase = $state<'idle' | 'input' | 'creating' | 'result'>('idle');
let stages = $state<Stage[]>([]);
let defaultNotebook = $state<string | null>(null);
let sweep = $state<SweepState>(emptySweep());

let navigateFn: NavigateFn | null = null;
let pendingGuid: string | null = null;
let readyResolve: (() => void) | null = null;
let createdGuid: string | null = null;
let createdTitle: string | null = null;
let matchedGuids: string[] = [];
let cancelFlag: { cancelled: boolean } = { cancelled: false };

const READY_TIMEOUT_MS = 5000;

function setStage(i: number, patch: Partial<Stage>) {
	stages[i] = { ...stages[i], ...patch };
}

/** Reset every flow field back to the idle baseline. Shared by cancel()
 *  (abandon the input dialog) and dismiss() (close the result panel) so the
 *  two can never drift as new state fields are added. */
function reset() {
	phase = 'idle';
	stages = [];
	navigateFn = null;
	pendingGuid = null;
	readyResolve = null;
	createdGuid = null;
	createdTitle = null;
	matchedGuids = [];
	sweep = emptySweep();
}

export const newNoteFlow = {
	get phase() { return phase; },
	get stages() { return stages; },
	get defaultNotebook() { return defaultNotebook; },
	get sweep() { return sweep; },

	open(opts: { notebook?: string | null; navigate: NavigateFn }) {
		defaultNotebook = opts.notebook ?? null;
		navigateFn = opts.navigate;
		stages = [];
		phase = 'input';
	},

	cancel() {
		reset();
	},

	/** 에디터가 새 노트 콘텐츠 스왑을 끝냈을 때 호출(TomboyEditor onnoteready). */
	markEditorReady(guid: string | null) {
		if (guid && guid === pendingGuid && readyResolve) {
			readyResolve();
			readyResolve = null;
		}
	},

	async submit(input: { title: string; typeId: string; notebook: string | null }) {
		const finalTitle = composeTitle(input.typeId, input.title).trim();
		// 타이틀 전역 유일 불변식 — 중복이면 생성하지 않고 입력 다이얼로그를 유지.
		const existing = await noteStore.findNoteByTitle(finalTitle);
		if (existing && !existing.deleted) {
			pushToast(`이미 "${finalTitle}" 제목의 노트가 있습니다. 다른 제목을 입력해 주세요.`, { kind: 'error' });
			return; // phase 는 'input' 유지 → 다이얼로그가 입력값을 그대로 들고 열려 있음
		}

		phase = 'creating';
		stages = [
			{ name: '노트 생성', ms: null, status: 'active' },
			{ name: '인덱스 갱신', ms: null, status: 'pending' },
			{ name: '에디터 여는 중', ms: null, status: 'pending' }
		];

		let succeeded = false;
		let noteGuid: string | null = null;
		try {
			// 1) 노트 생성
			let t0 = performance.now();
			const note = await createNote({
				title: finalTitle,
				bodyFirstLine: bodyFirstLine(input.typeId),
				notebook: input.notebook
			});
			setStage(0, { ms: Math.round(performance.now() - t0), status: 'done' });

			// 2) 인덱스 갱신(에디터가 곧 await 하는 인덱스를 미리 데움)
			setStage(1, { status: 'active' });
			t0 = performance.now();
			await ensureTitleIndexReady();
			await ensureBacklinkIndexReady();
			setStage(1, { ms: Math.round(performance.now() - t0), status: 'done' });

			// 3) 에디터 여는 중 — 네비게이션 후 onnoteready 신호까지
			setStage(2, { status: 'active' });
			t0 = performance.now();
			pendingGuid = note.guid;
			const readyP = new Promise<void>((res) => { readyResolve = res; });
			await navigateFn?.(note);
			await Promise.race([
				readyP,
				new Promise<void>((res) => setTimeout(res, READY_TIMEOUT_MS))
			]);
			setStage(2, { ms: Math.round(performance.now() - t0), status: 'done' });

			noteGuid = note.guid;
			succeeded = true;
		} catch (err) {
			console.error('[newNoteFlow] 노트 생성 실패', err);
			pushToast('노트 생성 중 오류가 발생했습니다.', { kind: 'error' });
		}

		if (succeeded && noteGuid) {
			// Success path: persist result state
			createdGuid = noteGuid;
			createdTitle = finalTitle;
			matchedGuids = [];
			sweep = emptySweep();
			navigateFn = null;
			pendingGuid = null;
			readyResolve = null;
			phase = 'result';
		} else {
			// Error path: return to idle and clear everything
			phase = 'idle';
			stages = [];
			pendingGuid = null;
			readyResolve = null;
			navigateFn = null;
		}
	},

	async startSweepCount() {
		if (!createdTitle || !createdGuid) return;
		if (sweep.status !== 'idle') return; // already counting/confirmed/applying
		cancelFlag = { cancelled: false };
		sweep = { ...sweep, status: 'counting', scanned: 0, total: 0, matched: 0 };
		try {
			await desktopSession.flushAll();
			const { matched, total } = await countLinkSweep(createdTitle, createdGuid, {
				cancelToken: cancelFlag,
				onProgress: (p) => {
					sweep = { ...sweep, scanned: p.scanned, total: p.total, matched: p.matched };
				}
			});
			if (cancelFlag.cancelled) {
				sweep = { ...sweep, status: 'idle' };
				return;
			}
			matchedGuids = matched;
			sweep = { ...sweep, status: 'confirm', total, matched: matched.length };
		} catch (err) {
			// Don't strand the panel at 'counting' with no recovery — surface the
			// error and return to idle so the user can dismiss or retry.
			console.error('[newNoteFlow] 링크 스캔 실패', err);
			pushToast('링크 스캔 중 오류가 발생했습니다.', { kind: 'error' });
			sweep = { ...sweep, status: 'idle' };
		}
	},

	async applySweep() {
		if (!createdTitle || !createdGuid) return;
		if (sweep.status !== 'confirm') return; // only after a count produced a confirm
		cancelFlag = { cancelled: false };
		const t0 = performance.now();
		sweep = { ...sweep, status: 'applying', updated: 0, failed: 0, total: matchedGuids.length };
		try {
			// Flush open editors right before the multi-note write: edits made in
			// the count→confirm gap must land in IDB first, else reloadWindows below
			// would clobber them (CLAUDE.md cross-window mutation pattern).
			await desktopSession.flushAll();
			const { updated, failed } = await applyLinkSweep(createdTitle, createdGuid, matchedGuids, {
				cancelToken: cancelFlag,
				onProgress: (p) => {
					sweep = { ...sweep, scanned: p.scanned, updated: p.matched };
				}
			});
			if (updated.length) {
				await emitNoteReload(updated);
				await desktopSession.reloadWindows(updated);
			}
			// A cancel mid-apply still reports 'done' with the partial count —
			// "M개 완료" is accurate (M notes were actually written).
			sweep = {
				...sweep,
				status: 'done',
				updated: updated.length,
				failed,
				ms: Math.round(performance.now() - t0)
			};
		} catch (err) {
			console.error('[newNoteFlow] 링크 반영 실패', err);
			pushToast('링크 반영 중 오류가 발생했습니다.', { kind: 'error' });
			sweep = { ...sweep, status: 'confirm' }; // back to confirm so the user can retry
		}
	},

	cancelSweep() {
		cancelFlag.cancelled = true;
	},

	dismiss() {
		reset();
	}
};
