<script lang="ts">
	import { onMount } from 'svelte';
	import { getNote, updateNoteFromEditor, getNoteEditorContent } from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import type { JSONContent } from '@tiptap/core';
	import { startPointerDrag } from './dragResize.js';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		registerFlushHook
	} from './session.svelte.js';

	interface Props {
		guid: string;
		x: number;
		y: number;
		width: number;
		height: number;
		z: number;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		onmove: (guid: string, x: number, y: number) => void;
		onresize: (guid: string, width: number, height: number) => void;
		onopenlink: (title: string) => void;
	}

	let {
		guid,
		x,
		y,
		width,
		height,
		z,
		onfocus,
		onclose,
		onmove,
		onresize,
		onopenlink
	}: Props = $props();

	let note = $state<NoteData | undefined>(undefined);
	let loading = $state(true);
	let saving = $state(false);
	let editorContent: JSONContent | undefined = $state(undefined);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingDoc: JSONContent | null = null;

	onMount(() => {
		(async () => {
			const loaded = await getNote(guid);
			if (!loaded) {
				loading = false;
				return;
			}
			note = loaded;
			editorContent = getNoteEditorContent(loaded);
			loading = false;
		})();

		// Register a flush hook so closeWindow() can persist unsaved edits.
		const unregister = registerFlushHook(guid, () => flushSave());

		return () => {
			unregister();
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
				// Best-effort final save; we don't await since onMount cleanup is sync.
				void flushSave();
			}
		};
	});

	function handleEditorChange(doc: JSONContent) {
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void flushSave();
		}, 1500);
	}

	async function flushSave(): Promise<void> {
		if (!pendingDoc || !note) return;
		saving = true;
		const updated = await updateNoteFromEditor(note.guid, pendingDoc);
		if (updated) note = updated;
		pendingDoc = null;
		saving = false;
	}

	async function handleInternalLink(target: string) {
		const title = target.trim();
		if (!title) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		onopenlink(title);
	}

	async function handleClose() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		onclose(guid);
	}

	function handleFocus() {
		onfocus(guid);
	}

	function startDrag(e: PointerEvent) {
		// Don't start drag from the close button.
		const targetEl = e.target as HTMLElement | null;
		if (targetEl?.closest('[data-no-drag]')) return;
		onfocus(guid);
		const origX = x;
		const origY = y;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				onmove(guid, origX + dx, origY + dy);
			}
		});
	}

	function startResize(e: PointerEvent) {
		e.stopPropagation();
		onfocus(guid);
		const origW = width;
		const origH = height;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				onresize(
					guid,
					Math.max(DESKTOP_WINDOW_MIN_WIDTH, origW + dx),
					Math.max(DESKTOP_WINDOW_MIN_HEIGHT, origH + dy)
				);
			}
		});
	}

	const titleDisplay = $derived(note?.title?.trim() || '제목 없음');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="note-window"
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleFocus}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="title-bar"
		onpointerdown={startDrag}
	>
		<span class="title-text">
			{#if saving}<span class="save-dot" title="저장 중"></span>{/if}
			{titleDisplay}
		</span>
		<button
			type="button"
			class="close-btn"
			onclick={handleClose}
			aria-label="창 닫기"
			data-no-drag
		>✕</button>
	</div>

	<div class="body">
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if editorContent}
			<TomboyEditor
				content={editorContent}
				onchange={handleEditorChange}
				oninternallink={handleInternalLink}
				currentGuid={guid}
			/>
		{:else}
			<div class="loading">노트를 불러올 수 없습니다.</div>
		{/if}
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resize-grip"
		onpointerdown={startResize}
		aria-hidden="true"
	></div>
</div>

<style>
	.note-window {
		position: absolute;
		display: flex;
		flex-direction: column;
		background: #fff;
		color: #111;
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
		min-width: 280px;
		min-height: 240px;
	}

	.title-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		background: #2a2a2a;
		color: #eee;
		cursor: grab;
		user-select: none;
		touch-action: none;
		flex-shrink: 0;
	}

	.title-bar:active {
		cursor: grabbing;
	}

	.title-text {
		flex: 1;
		font-size: 0.85rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.save-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #f5a623;
		margin-right: 4px;
		vertical-align: middle;
	}

	.close-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: #ccc;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
	}

	.close-btn:hover {
		background: #c0392b;
		color: #fff;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.body :global(.tomboy-editor) {
		flex: 1;
		min-height: 0;
	}

	.loading {
		padding: 24px;
		text-align: center;
		color: #888;
	}

	.resize-grip {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 16px;
		height: 16px;
		cursor: nwse-resize;
		touch-action: none;
		background:
			linear-gradient(
				135deg,
				transparent 0%,
				transparent 50%,
				#888 50%,
				#888 55%,
				transparent 55%,
				transparent 65%,
				#888 65%,
				#888 70%,
				transparent 70%,
				transparent 80%,
				#888 80%,
				#888 85%,
				transparent 85%
			);
	}
</style>
