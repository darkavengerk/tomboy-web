<script lang="ts">
	import { onMount } from 'svelte';
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		HISTORY_GUID_PREFIX,
		desktopSession
	} from './session.svelte.js';
	import { createNoteHistory, formatVersionLabel, noteToPlainText } from './noteHistory.svelte.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import { getNoteEditorContent } from '$lib/core/noteManager.js';
	import { getNote } from '$lib/storage/noteStore.js';
	import { lineDiff, type DiffOp } from '$lib/sync/diffNote.js';
	import type { NoteData } from '$lib/core/note.js';
	import type { JSONContent } from '@tiptap/core';

	interface Props {
		guid: string; // history window guid: __history__<sourceGuid>
		x: number; y: number; width: number; height: number; z: number;
		pinned?: boolean; active?: boolean;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		onmove: (guid: string, x: number, y: number) => void;
		onresize: (guid: string, width: number, height: number) => void;
	}
	let { guid, x, y, width, height, z, pinned = false, active = true,
		onfocus, onclose, onmove, onresize }: Props = $props();

	// svelte-ignore state_referenced_locally
	const sourceGuid = guid.slice(HISTORY_GUID_PREFIX.length);
	const history = createNoteHistory(sourceGuid);

	let selectedRev = $state<number | null>(null);
	let selectedNote = $state<NoteData | null>(null);
	let renderContent = $state<JSONContent | undefined>(undefined);
	let bodyLoading = $state(false);
	let showDiff = $state(false);
	let sourceTitle = $state('');
	let liveText = '';
	let diffOps = $state<DiffOp[]>([]);
	onMount(() => { void init(); });

	async function init() {
		const live = await getNote(sourceGuid);
		sourceTitle = live?.title ?? '';
		liveText = live ? noteToPlainText(live) : '';
		await history.load();
		const def = history.versions[1] ?? history.versions[0];
		if (def) await selectRev(def.rev);
	}

	async function selectRev(rev: number) {
		selectedRev = rev;
		bodyLoading = true;
		try {
			const note = await history.fetchBody(rev);
			selectedNote = note;
			renderContent = note ? getNoteEditorContent(note) : undefined;
			recomputeDiff();
		} finally {
			bodyLoading = false;
		}
	}

	function recomputeDiff() {
		diffOps = selectedNote ? lineDiff(liveText, noteToPlainText(selectedNote)) : [];
	}

	function onSelectChange(e: Event) {
		const rev = parseInt((e.currentTarget as HTMLSelectElement).value, 10);
		if (Number.isFinite(rev)) void selectRev(rev);
	}

	function handleFocus() { onfocus(guid); }
	function handleClose() { onclose(guid); }
	function startDrag(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-no-drag]')) return;
		onfocus(guid);
		const ox = x, oy = y;
		startPointerDrag(e, { onMove: (dx, dy) => onmove(guid, ox + dx, oy + dy) });
	}
	function handlePinToggle(e: MouseEvent) { e.stopPropagation(); desktopSession.togglePin(guid); }
	function handleAux(e: MouseEvent) { if (e.button === 1) { e.preventDefault(); desktopSession.sendToBack(guid); } }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="history-window"
	class:hidden={!active}
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="title-bar" onpointerdown={startDrag} onauxclick={handleAux}>
		<span class="title-text">히스토리 — {sourceTitle}</span>
		<button type="button" class="pin-btn" class:pinned onclick={handlePinToggle}
			aria-label={pinned ? '항상 위 해제' : '항상 위'} title={pinned ? '항상 위 해제' : '항상 위'} data-no-drag>&#x1F4CC;</button>
		<button type="button" class="close-btn" onclick={handleClose} aria-label="창 닫기" data-no-drag>✕</button>
	</div>

	<div class="toolbar" data-no-drag>
		{#if history.loading && history.versions.length === 0}
			<span class="muted">버전 목록 불러오는 중…</span>
		{:else if history.error}
			<span class="error">오류: {history.error}</span>
		{:else if history.versions.length === 0}
			<span class="muted">이 노트의 Dropbox 히스토리가 없습니다.</span>
		{:else}
			<select class="ver-select" onchange={onSelectChange} value={selectedRev ?? ''}>
				{#each history.versions as v, i}
					<option value={v.rev}>
						{formatVersionLabel(v)}{i === 0 ? ' (현재)' : ''}
					</option>
				{/each}
			</select>
			<button type="button" class="diff-toggle" class:on={showDiff}
				onclick={() => { showDiff = !showDiff; if (showDiff) recomputeDiff(); }}>↔ diff</button>
			{#if history.usedFallback && history.hasMore}
				<button type="button" class="more-btn" onclick={() => history.loadMore()} disabled={history.loading}>
					{history.loading ? '…' : '더 불러오기'}
				</button>
			{/if}
		{/if}
	</div>

	<div class="body">
		{#if bodyLoading}
			<div class="muted pad">버전 불러오는 중…</div>
		{:else if selectedNote === null && selectedRev !== null}
			<div class="error pad">이 버전을 불러올 수 없습니다.</div>
		{:else if showDiff}
			<div class="diff">
				{#each diffOps as op}
					<div class="dl {op.type}">{op.type === 'added' ? '+' : op.type === 'removed' ? '−' : ' '} {op.text}</div>
				{/each}
			</div>
		{:else if renderContent}
			<TomboyEditor content={renderContent} readOnly={true} />
		{/if}
	</div>

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guid, g)}
	/>
</div>

<style>
	.history-window {
		position: absolute; display: flex; flex-direction: column;
		background: #fff; color: #111; border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); overflow: hidden;
		min-width: 280px; min-height: 240px;
	}
	.history-window.hidden { display: none; }
	.title-bar {
		display: flex; align-items: center; gap: 8px; padding: 6px 10px;
		background: #2a2a2a; color: #eee; cursor: grab; user-select: none;
		touch-action: none; flex-shrink: 0;
	}
	.title-bar:active { cursor: grabbing; }
	.title-text { flex: 1; font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.pin-btn, .close-btn {
		flex-shrink: 0; width: 22px; height: 22px; border: none; background: transparent;
		color: #ccc; font-size: 0.85rem; line-height: 1; cursor: pointer; border-radius: 3px;
	}
	.pin-btn { color: #888; opacity: 0.5; }
	.pin-btn:hover, .pin-btn.pinned { opacity: 1; background: rgba(255,255,255,0.15); color: #fff; }
	.close-btn:hover { background: #c0392b; color: #fff; }
	.toolbar {
		display: flex; align-items: center; gap: 8px; padding: 6px 10px;
		border-bottom: 1px solid #e4e8ec; background: #f7f7f8; flex-shrink: 0;
		font-size: 0.8rem;
	}
	.ver-select { flex: 1; min-width: 0; font-size: 0.8rem; padding: 3px 6px; }
	.diff-toggle, .more-btn {
		flex-shrink: 0; border: 1px solid #d0d7de; background: #fff; border-radius: 4px;
		padding: 3px 8px; font-size: 0.78rem; cursor: pointer;
	}
	.diff-toggle.on { background: #2563eb; color: #fff; border-color: #2563eb; }
	.body { flex: 1; min-height: 0; overflow: auto; }
	.pad { padding: 16px; }
	.muted { color: #6b7280; }
	.error { color: #b91c1c; }
	.diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; padding: 8px 0; }
	.dl { white-space: pre-wrap; padding: 0 10px; }
	.dl.added { background: #e6ffed; }
	.dl.removed { background: #ffeef0; }
	.dl.equal { color: #444; }
</style>
