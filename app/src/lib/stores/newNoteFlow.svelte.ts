import type { NoteData } from '$lib/core/note.js';
import { createNote } from '$lib/core/noteManager.js';
import { ensureTitleIndexReady } from '$lib/editor/autoLink/titleProvider.js';
import { ensureBacklinkIndexReady } from '$lib/core/backlinkIndex.js';
import { composeTitle, bodyFirstLine } from '$lib/noteTypes/registry.js';

export interface Stage {
	name: string;
	ms: number | null;
	status: 'pending' | 'active' | 'done';
}

type NavigateFn = (note: NoteData) => void | Promise<void>;

let phase = $state<'idle' | 'input' | 'creating'>('idle');
let stages = $state<Stage[]>([]);
let defaultNotebook = $state<string | null>(null);

let navigateFn: NavigateFn | null = null;
let pendingGuid: string | null = null;
let readyResolve: (() => void) | null = null;

const READY_TIMEOUT_MS = 5000;

function setStage(i: number, patch: Partial<Stage>) {
	stages[i] = { ...stages[i], ...patch };
}

export const newNoteFlow = {
	get phase() { return phase; },
	get stages() { return stages; },
	get defaultNotebook() { return defaultNotebook; },

	open(opts: { notebook?: string | null; navigate: NavigateFn }) {
		defaultNotebook = opts.notebook ?? null;
		navigateFn = opts.navigate;
		stages = [];
		phase = 'input';
	},

	cancel() {
		phase = 'idle';
		stages = [];
		navigateFn = null;
		pendingGuid = null;
		readyResolve = null;
	},

	/** 에디터가 새 노트 콘텐츠 스왑을 끝냈을 때 호출(TomboyEditor onnoteready). */
	markEditorReady(guid: string | null) {
		if (guid && guid === pendingGuid && readyResolve) {
			readyResolve();
			readyResolve = null;
		}
	},

	async submit(input: { title: string; typeId: string; notebook: string | null }) {
		phase = 'creating';
		stages = [
			{ name: '노트 생성', ms: null, status: 'active' },
			{ name: '인덱스 갱신', ms: null, status: 'pending' },
			{ name: '에디터 여는 중', ms: null, status: 'pending' }
		];

		// 1) 노트 생성
		let t0 = performance.now();
		const finalTitle = composeTitle(input.typeId, input.title);
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

		phase = 'idle';
		pendingGuid = null;
		readyResolve = null;
		navigateFn = null;
	}
};
