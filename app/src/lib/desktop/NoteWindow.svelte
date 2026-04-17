<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getNote,
		updateNoteFromEditor,
		getNoteEditorContent,
		deleteNoteById,
		toggleFavorite,
		isFavorite
	} from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import Toolbar from '$lib/editor/Toolbar.svelte';
	import NoteContextMenu, { type ActionKind } from '$lib/editor/NoteContextMenu.svelte';
	import NotebookPicker from '$lib/components/NotebookPicker.svelte';
	import { assignNotebook, getNotebook } from '$lib/core/notebooks.js';
	import { setHomeNote, clearHomeNote, getHomeNoteGuid } from '$lib/core/home.js';
	import { isScrollBottomNote, setScrollBottomNote } from '$lib/core/scrollBottom.js';
	import { pushToast } from '$lib/stores/toast.js';
	import { removeNoteRevision } from '$lib/sync/manifest.js';
	import { purgeLocalOnly } from '$lib/storage/noteStore.js';
	import { sync } from '$lib/sync/syncManager.js';
	import type { JSONContent, Editor } from '@tiptap/core';
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		registerFlushHook,
		desktopSession
	} from './session.svelte.js';

	interface Props {
		guid: string;
		x: number;
		y: number;
		width: number;
		height: number;
		z: number;
		pinned?: boolean;
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
		pinned = false,
		onfocus,
		onclose,
		onmove,
		onresize,
		onopenlink
	}: Props = $props();

	// `$state.raw` instead of `$state` for the big content holders. Svelte's
	// default deep proxy makes every property read go through a trap, and
	// TipTap's Editor constructor walks the full JSON tree to build the PM
	// doc — that walk is O(nodes) proxy allocations for large notes,
	// which is the main contributor to the "seconds of lag when opening a
	// closed note" symptom. We never mutate these objects in place (only
	// reassign the variable), so raw state preserves the reactivity we
	// actually need without paying the proxy tax.
	let note = $state.raw<NoteData | undefined>(undefined);
	let loading = $state(true);
	let saving = $state(false);
	let editorContent: JSONContent | undefined = $state.raw(undefined);
	let editorComponent: TomboyEditor | undefined = $state(undefined);
	let menuAnchor = $state<{ right: number; top: number } | null>(null);
	let pickerOpen = $state(false);
	let isHomeState = $state(false);
	let isScrollBottomState = $state(false);
	let windowEl: HTMLDivElement | undefined = $state(undefined);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingDoc: JSONContent | null = $state.raw(null);
	// Fingerprint of the last successfully-flushed doc. flushSave() skips
	// the whole save pipeline (IDB read + XML serialize) when the incoming
	// doc stringifies identically — catches the type-and-undo case cheaply.
	let lastSavedDocFingerprint: string | null = null;

	const isFavoriteState = $derived(note ? isFavorite(note) : false);
	const currentNotebook = $derived(note ? getNotebook(note) : null);

	function getEditor(): Editor | null {
		return editorComponent?.getEditor() ?? null;
	}

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

			const homeGuid = await getHomeNoteGuid();
			isHomeState = homeGuid === guid;

			isScrollBottomState = await isScrollBottomNote(guid);
			if (isScrollBottomState) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => scrollEditorToBottom());
				});
			}
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

	// Register the Tiptap editor with the session so global shortcuts
	// (Ctrl+L) can access the current selection.
	$effect(() => {
		const ec = editorComponent;
		if (!ec) return;
		const editor = ec.getEditor();
		if (!editor) return;
		const off = desktopSession.registerEditor(guid, editor);
		return off;
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
		const fingerprint = JSON.stringify(pendingDoc);
		if (fingerprint === lastSavedDocFingerprint) {
			pendingDoc = null;
			return;
		}
		saving = true;
		const updated = await updateNoteFromEditor(note.guid, pendingDoc);
		if (updated) note = updated;
		lastSavedDocFingerprint = fingerprint;
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

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		// Let any overlay (notebook picker, editor/note context menu,
		// action sheet) swallow Esc first. Those are rendered as siblings
		// of .note-window at the component root, so they don't appear in
		// this subtree — a DOM query is the least brittle gate and also
		// sidesteps cross-handler ordering with their svelte:window Esc
		// listeners.
		if (document.querySelector('.ctx-menu, .picker, .sheet')) return;
		e.preventDefault();
		void handleClose();
	}

	// When `openWindow` / `openWindowAt` for this guid fires (via link
	// click, Ctrl+L new-note, or programmatic), desktopSession raises a
	// focusRequest. Match it, focus the editor so Esc closes the
	// newly-opened / newly-raised note, and flash the border to show the
	// user where focus just landed.
	$effect(() => {
		const req = desktopSession.focusRequest;
		if (!req || req.guid !== guid) return;
		const ed = editorComponent?.getEditor();
		if (!ed || ed.isDestroyed) return;
		// Defer one frame so the newly-mounted window has a layout before
		// we grab focus (avoids scroll jumps on tall canvases).
		requestAnimationFrame(() => {
			try {
				ed.commands.focus();
			} catch {
				/* editor torn down between frames */
			}
			flashBorder();
		});
	});

	function flashBorder(): void {
		const el = windowEl;
		if (!el || typeof el.animate !== 'function') return;
		// WAAPI retriggers reliably on every call, unlike CSS animation
		// classes which need a reflow dance. The base box-shadow comes
		// from .note-window's CSS; we re-assert it in both keyframes so
		// the animation interpolates only the blue ring.
		const baseShadow = '0 8px 24px rgba(0, 0, 0, 0.5)';
		el.animate(
			[
				{
					boxShadow: `0 0 0 2px rgba(120, 180, 255, 0.95), ${baseShadow}`
				},
				{
					boxShadow: `0 0 0 8px rgba(120, 180, 255, 0), ${baseShadow}`
				}
			],
			{ duration: 450, easing: 'ease-out' }
		);
	}

	function handleWindowPointerDown(e: PointerEvent) {
		// Always raise-to-top on any pointer inside the window.
		onfocus(guid);
		if (!e.altKey) return;
		const targetEl = e.target as HTMLElement | null;
		// Let the close button / resize grip do their thing.
		if (targetEl?.closest('[data-no-drag]')) return;
		if (targetEl?.closest('.resize-grip')) return;
		// Alt held anywhere else: start a drag from the window root and
		// suppress the inner handlers (title-bar, editor text selection, etc.).
		e.preventDefault();
		e.stopPropagation();
		const origX = x;
		const origY = y;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				onmove(guid, origX + dx, origY + dy);
			}
		});
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

	function handlePinToggle(e: MouseEvent) {
		e.stopPropagation();
		desktopSession.togglePin(guid);
	}

	function handleTitleBarAuxClick(e: MouseEvent) {
		if (e.button === 1) {
			e.preventDefault();
			desktopSession.sendToBack(guid);
		}
	}

	function scrollEditorToBottom() {
		const ed = getEditor();
		const el = ed?.view.dom.parentElement as HTMLElement | undefined;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}

	function openMenu(e: MouseEvent) {
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		menuAnchor = {
			right: Math.max(4, window.innerWidth - rect.right),
			top: rect.bottom + 4
		};
	}

	async function handleAction(kind: ActionKind) {
		menuAnchor = null;
		if (!note) return;

		if (kind === 'delete') {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			pendingDoc = null;
			const guidToDelete = note.guid;
			await deleteNoteById(guidToDelete);
			pushToast('삭제되었습니다.');
			onclose(guidToDelete);
			return;
		}

		if (kind === 'redownload') {
			if (pendingDoc || saving) {
				pushToast('저장되지 않은 변경사항이 있습니다.', { kind: 'error' });
				return;
			}
			await removeNoteRevision(note.guid);
			await purgeLocalOnly(note.guid);
			const r = await sync();
			if (r.status === 'success') {
				pushToast('다시 다운로드 완료.');
			} else {
				pushToast('동기화 실패: ' + (r.errors[0] ?? '알 수 없는 오류'), { kind: 'error' });
			}
			onclose(note.guid);
			return;
		}

		if (kind === 'toggleFavorite') {
			const updated = await toggleFavorite(note.guid);
			if (updated) note = updated;
			pushToast(
				isFavorite(note!) ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.'
			);
			return;
		}

		if (kind === 'setHome') {
			await setHomeNote(note.guid);
			isHomeState = true;
			pushToast('홈 노트로 지정되었습니다.');
			return;
		}

		if (kind === 'unsetHome') {
			await clearHomeNote();
			isHomeState = false;
			pushToast('홈 노트 지정이 해제되었습니다.');
			return;
		}

		if (kind === 'pickNotebook') {
			pickerOpen = true;
			return;
		}

		if (kind === 'toggleScrollBottom') {
			const next = !isScrollBottomState;
			await setScrollBottomNote(note.guid, next);
			isScrollBottomState = next;
			pushToast(
				next ? '이 노트는 열 때 항상 맨 아래로 이동합니다.' : '맨 아래 이동이 해제되었습니다.'
			);
			if (next) scrollEditorToBottom();
			return;
		}

		if (kind === 'compareWithServer') {
			window.open(`/note/${note.guid}/compare`, '_blank');
			return;
		}
	}

	async function handleNotebookSelect(name: string | null) {
		if (!note) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		await assignNotebook(note.guid, name);
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		pickerOpen = false;
		pushToast('노트북이 변경되었습니다.');
	}

	function handleActionGoto(targetGuid: string) {
		menuAnchor = null;
		desktopSession.openWindow(targetGuid);
	}

	const titleDisplay = $derived(note?.title?.trim() || '제목 없음');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={windowEl}
	class="note-window"
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	onpointerdowncapture={handleWindowPointerDown}
	onkeydown={handleKeyDown}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="title-bar"
		onpointerdown={startDrag}
		onauxclick={handleTitleBarAuxClick}
	>
		<span class="title-text">
			{#if saving}<span class="save-dot" title="저장 중"></span>{/if}
			{titleDisplay}
		</span>
		<button
			type="button"
			class="pin-btn"
			class:pinned
			onclick={handlePinToggle}
			aria-label={pinned ? '항상 위 해제' : '항상 위'}
			title={pinned ? '항상 위 해제' : '항상 위'}
			data-no-drag
		>&#x1F4CC;</button>
		<button
			type="button"
			class="close-btn"
			onclick={handleClose}
			aria-label="창 닫기"
			data-no-drag
		>✕</button>
	</div>

	{#if !loading && editorContent}
		<div class="toolbar-slot">
			<Toolbar
				editor={getEditor()}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
			/>
			{#if note}
				<button
					type="button"
					class="menu-btn"
					onclick={openMenu}
					aria-label="더 보기"
					title="더 보기"
				>⋯</button>
			{/if}
		</div>
	{/if}

	<div class="body">
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if editorContent}
			<TomboyEditor
				bind:this={editorComponent}
				content={editorContent}
				onchange={handleEditorChange}
				oninternallink={handleInternalLink}
				currentGuid={guid}
				enableContextMenu={true}
			/>
		{:else}
			<div class="loading">노트를 불러올 수 없습니다.</div>
		{/if}
	</div>

	<ResizeHandles
		base={() => ({ x, y, width, height })}
		min={{ width: DESKTOP_WINDOW_MIN_WIDTH, height: DESKTOP_WINDOW_MIN_HEIGHT }}
		onresize={(g) => desktopSession.updateGeometry(guid, g)}
	/>
</div>

{#if menuAnchor && note}
	<NoteContextMenu
		note={note}
		dirty={!!(pendingDoc || saving)}
		isFavoriteNote={isFavoriteState}
		isHomeNote={isHomeState}
		isScrollBottomNote={isScrollBottomState}
		anchor={menuAnchor}
		onaction={handleAction}
		onclose={() => (menuAnchor = null)}
		ongoto={handleActionGoto}
	/>
{/if}

{#if pickerOpen && note}
	<NotebookPicker
		current={currentNotebook}
		onselect={handleNotebookSelect}
		onclose={() => (pickerOpen = false)}
	/>
{/if}

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

	.pin-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: #888;
		font-size: 0.75rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
		opacity: 0.5;
	}

	.pin-btn:hover,
	.pin-btn.pinned {
		opacity: 1;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
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

	.toolbar-slot {
		flex-shrink: 0;
		display: flex;
		align-items: stretch;
		border-bottom: 1px solid #dee2e6;
		background: #f8f9fa;
	}

	.toolbar-slot :global(.toolbar) {
		flex: 1;
		min-width: 0;
		border-top: none;
	}

	/* Flip the size-menu downward since the toolbar is now at the top. */
	.toolbar-slot :global(.size-menu) {
		top: 100%;
		bottom: auto;
	}

	.menu-btn {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		margin: 6px 8px 6px 4px;
		border: none;
		background: transparent;
		color: #495057;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 6px;
	}

	.menu-btn:hover {
		background: #dee2e6;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		/* Size container for image previews (max-height: 100cqh inside
		   TomboyEditor). Safe: .body has a definite height via flex:1
		   with min-height:0 inside the .note-window flex column. */
		container-type: size;
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

</style>
