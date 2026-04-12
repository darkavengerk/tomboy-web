<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		getNote,
		updateNoteFromEditor,
		deleteNoteById,
		getNoteEditorContent,
		createNote,
		findNoteByTitle,
		toggleFavorite,
		isFavorite,
		listNotes
	} from '$lib/core/noteManager.js';
	import type { NoteData } from '$lib/core/note.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import Toolbar from '$lib/editor/Toolbar.svelte';
	import NoteActionSheet, { type ActionKind } from '$lib/editor/NoteActionSheet.svelte';
	import NotebookPicker from '$lib/components/NotebookPicker.svelte';
	import type { JSONContent, Editor } from '@tiptap/core';
	import { pushToast } from '$lib/stores/toast.js';
	import { removeNoteRevision } from '$lib/sync/manifest.js';
	import { purgeLocalOnly } from '$lib/storage/noteStore.js';
	import { sync } from '$lib/sync/syncManager.js';
	import { assignNotebook, getNotebook } from '$lib/core/notebooks.js';
	import { setHomeNote, clearHomeNote, getHomeNoteGuid } from '$lib/core/home.js';

	let note: NoteData | undefined = $state(undefined);
	let loading = $state(true);
	let saving = $state(false);
	let editorComponent: TomboyEditor | undefined = $state(undefined);
	let editorContent: JSONContent | undefined = $state(undefined);
	let actionSheetOpen = $state(false);
	let pickerOpen = $state(false);
	let isHomeNoteState = $state(false);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let loadedGuid: string | null = null;
	let pendingDoc: JSONContent | null = $state(null);

	const noteId = $derived(page.params.id);
	const isFromHome = $derived(page.url.searchParams.get('from') === 'home');
	const currentNotebook = $derived(note ? getNotebook(note) : null);
	const isFavoriteNote = $derived(note ? isFavorite(note) : false);

	// Route 변경 시 에디터 재로드
	$effect(() => {
		const id = noteId;
		if (!id || id === loadedGuid) return;
		loadedGuid = id;
		loading = true;
		editorContent = undefined;
		note = undefined;

		(async () => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
				await flushSave();
			}

			const loaded = await getNote(id);
			if (id !== noteId) return;
			if (!loaded) {
				goto('/');
				return;
			}
			note = loaded;
			editorContent = getNoteEditorContent(loaded);
			loading = false;

			const homeGuid = await getHomeNoteGuid();
			isHomeNoteState = homeGuid === id;
		})();
	});

	onMount(() => {
		return () => {
			if (saveTimer) {
				clearTimeout(saveTimer);
				flushSave();
			}
		};
	});

	function handleEditorChange(doc: JSONContent) {
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => { flushSave(); }, 1500);
	}

	async function flushSave() {
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

		const linked = await findNoteByTitle(title);
		if (!linked) {
			pushToast(`'${title}' 노트를 찾을 수 없습니다.`, { kind: 'error' });
			return;
		}
		if (linked.guid === noteId) return;
		goto(`/note/${linked.guid}`);
	}

	function getEditor(): Editor | null {
		return editorComponent?.getEditor() ?? null;
	}

	async function handleExtractNote() {
		const editor = getEditor();
		if (!editor) return;

		const { from, to, empty } = editor.state.selection;
		if (empty || from === to) return;

		const selectedText = editor.state.doc.textBetween(from, to, ' ').trim();
		if (!selectedText) return;

		const title = selectedText.length > 120 ? selectedText.slice(0, 120) : selectedText;
		const existing = await findNoteByTitle(title);
		const target = existing ?? (await createNote(title));

		editor
			.chain()
			.focus()
			.setTextSelection({ from, to })
			.setTomboyInternalLink({ target: title })
			.run();

		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		pendingDoc = editor.getJSON();
		await flushSave();

		goto(`/note/${target.guid}`);
	}

	async function handleAction(kind: ActionKind) {
		actionSheetOpen = false;

		if (kind === 'delete') {
			if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
			await deleteNoteById(note!.guid);
			pushToast('삭제되었습니다.');
			goto('/');
			return;
		}

		if (kind === 'redownload') {
			if (pendingDoc || saving) {
				pushToast('저장되지 않은 변경사항이 있습니다.', { kind: 'error' });
				return;
			}
			await removeNoteRevision(note!.guid);
			await purgeLocalOnly(note!.guid);
			const r = await sync();
			if (r.status === 'success') {
				pushToast('다시 다운로드 완료.');
			} else {
				pushToast('동기화 실패: ' + (r.errors[0] ?? '알 수 없는 오류'), { kind: 'error' });
			}
			goto('/');
			return;
		}

		if (kind === 'toggleFavorite') {
			const updated = await toggleFavorite(note!.guid);
			if (updated) note = updated;
			pushToast(isFavorite(note!) ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
			return;
		}

		if (kind === 'setHome') {
			await setHomeNote(note!.guid);
			isHomeNoteState = true;
			pushToast('홈 노트로 지정되었습니다.');
			return;
		}

		if (kind === 'unsetHome') {
			await clearHomeNote();
			isHomeNoteState = false;
			pushToast('홈 노트 지정이 해제되었습니다.');
			return;
		}

		if (kind === 'pickNotebook') {
			pickerOpen = true;
			return;
		}
	}

	async function gotoRandom() {
		const all = (await listNotes()).filter((n) => !n.deleted && n.guid !== noteId);
		if (all.length === 0) return;
		const picked = all[Math.floor(Math.random() * all.length)];
		goto(`/note/${picked.guid}?from=home`);
	}

	async function handleNotebookSelect(name: string | null) {
		if (!note) return;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
		await assignNotebook(note.guid, name);
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		pickerOpen = false;
		pushToast('노트북이 변경되었습니다.');
	}
</script>

<div class="editor-page">
	<!-- 저장 상태 + 노트북/액션 버튼을 에디터 위 간결한 바로 -->
	<div class="editor-meta-bar">
		<span class="save-indicator" class:visible={saving}>저장 중...</span>
		{#if note}
			<button
				class="notebook-chip"
				onclick={() => (pickerOpen = true)}
				title="노트북"
			>
				{#if currentNotebook}
					🗂 {currentNotebook}
				{:else}
					🗂
				{/if}
			</button>
			<button
				class="action-btn"
				onclick={() => (actionSheetOpen = true)}
				title="더 보기"
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
					<circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
				</svg>
			</button>
		{/if}
	</div>

	<div class="editor-area">
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if editorContent}
			{#key noteId}
				<TomboyEditor
					bind:this={editorComponent}
					content={editorContent}
					onchange={handleEditorChange}
					oninternallink={handleInternalLink}
				/>
			{/key}
		{/if}
	</div>

	<div class="toolbar-area">
		<Toolbar editor={getEditor()} onextractnote={handleExtractNote} />
	</div>

	{#if isFromHome}
		<button class="fab-random" onclick={gotoRandom} aria-label="랜덤 노트">🎲</button>
	{/if}
</div>

{#if actionSheetOpen && note}
	<NoteActionSheet
		{note}
		dirty={!!(pendingDoc || saving)}
		isFavoriteNote={isFavoriteNote}
		isHomeNote={isHomeNoteState}
		onaction={handleAction}
		onclose={() => (actionSheetOpen = false)}
		ongoto={(guid) => { actionSheetOpen = false; goto(`/note/${guid}`); }}
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
	.editor-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		position: relative;
	}

	.editor-meta-bar {
		position: absolute;
		top: 4px;
		right: 4px;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 4px;
		padding: 4px;
		z-index: 5;
		pointer-events: none;
		opacity: 0.35;
		transition: opacity 0.2s;
	}

	.editor-meta-bar:has(:hover),
	.editor-meta-bar:has(:focus-visible) {
		opacity: 1;
	}

	.save-indicator,
	.notebook-chip,
	.action-btn {
		pointer-events: auto;
	}

	.save-indicator {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		margin-right: auto;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.save-indicator.visible {
		opacity: 1;
	}

	.notebook-chip {
		flex-shrink: 0;
		background: rgba(232, 240, 254, 0.92);
		backdrop-filter: blur(6px);
		color: #1a73e8;
		border: none;
		border-radius: 12px;
		padding: 4px 10px;
		font-size: 0.8rem;
		cursor: pointer;
		max-width: 120px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: none;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(6px);
		border-radius: 50%;
		color: var(--color-text-secondary);
		flex-shrink: 0;
		cursor: pointer;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.action-btn:active {
		background: var(--color-bg-secondary);
	}

	.editor-area {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.toolbar-area {
		flex-shrink: 0;
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--color-text-secondary);
	}

	.fab-random {
		position: fixed;
		bottom: calc(88px + var(--safe-area-bottom));
		right: 20px;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		border: none;
		background: var(--color-bg);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		font-size: 1.4rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		z-index: 10;
	}

	.fab-random:active {
		transform: scale(0.93);
	}
</style>
