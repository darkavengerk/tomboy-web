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
	import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
	import type { NoteData } from '$lib/core/note.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import Toolbar from '$lib/editor/Toolbar.svelte';
	import NoteActionSheet, { type ActionKind } from '$lib/editor/NoteActionSheet.svelte';
	import NotebookPicker from '$lib/components/NotebookPicker.svelte';
	import { SLIPBOX_NOTEBOOK } from '$lib/sleepnote/validator.js';
	import {
		insertNewNoteAfter,
		cutFromChain,
		pasteAfter,
		disconnectFromPrev,
		connectAfter
	} from '$lib/sleepnote/ops.js';
	import { slipClipboard } from '$lib/sleepnote/clipboard.svelte.js';
	import type { JSONContent, Editor } from '@tiptap/core';
	import { pushToast } from '$lib/stores/toast.js';
	import { removeNoteRevision } from '$lib/sync/manifest.js';
	import { purgeLocalOnly } from '$lib/storage/noteStore.js';
	import { sync } from '$lib/sync/syncManager.js';
	import { assignNotebook, getNotebook } from '$lib/core/notebooks.js';
	import { setHomeNote, clearHomeNote, getHomeNoteGuid } from '$lib/core/home.js';
	import { isScrollBottomNote, setScrollBottomNote } from '$lib/core/scrollBottom.js';

	// `$state.raw` for the large-content holders. Svelte's default deep
	// proxy traps every property read, and TipTap's Editor walks the full
	// content tree on construction (and on setContent for note switches)
	// — a 10k-node doc pays O(n) proxy allocations each time. These vars
	// are only ever reassigned (never mutated in place), so raw state is
	// both safe and significantly faster for big notes.
	let note: NoteData | undefined = $state.raw(undefined);
	let loading = $state(true);
	let saving = $state(false);
	let editorComponent: TomboyEditor | undefined = $state(undefined);
	let editorContent: JSONContent | undefined = $state.raw(undefined);
	let actionSheetOpen = $state(false);
	let pickerOpen = $state(false);
	let isHomeNoteState = $state(false);
	let isScrollBottomState = $state(false);
	let editorAreaEl: HTMLDivElement | undefined = $state(undefined);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let loadedGuid: string | null = null;
	let pendingDoc: JSONContent | null = $state.raw(null);
	// Fingerprint of the last successfully-flushed doc. flushSave() skips
	// calling updateNoteFromEditor() when the new doc stringifies to the
	// same value — this catches the type-and-undo case without paying for
	// an IDB read + serializeContent() XML pass on every save timer tick.
	let lastSavedDocFingerprint: string | null = null;

	const noteId = $derived(page.params.id);
	const isFromHome = $derived(page.url.searchParams.get('from') === 'home');
	const currentNotebook = $derived(note ? getNotebook(note) : null);
	const isFavoriteNote = $derived(note ? isFavorite(note) : false);
	const isSlipNote = $derived(currentNotebook === SLIPBOX_NOTEBOOK);
	const canPasteSlip = $derived(
		isSlipNote && slipClipboard.hasEntry && slipClipboard.guid !== noteId
	);
	const slipClipboardMode = $derived(slipClipboard.mode);
	let cutSlipTitle = $state<string | null>(null);
	$effect(() => {
		const g = slipClipboard.guid;
		if (!g) { cutSlipTitle = null; return; }
		getNote(g).then((n) => { cutSlipTitle = n?.title ?? null; });
	});

	// Subscribe to the note reload bus for the currently-loaded guid. Fires
	// when another note's rename rewrote a <link:internal>Oldtitle</link:internal>
	// mark inside THIS note's xml — we need to drop the in-memory pendingDoc
	// (which still carries the old title) and refresh the editor from IDB,
	// otherwise the next debounced save would clobber the sweep's fix.
	$effect(() => {
		const g = note?.guid;
		if (!g) return;
		const off = subscribeNoteReload(g, async () => {
			// Cancel any pending debounced save so the stale doc it holds
			// doesn't win the race with the fresh IDB content.
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			pendingDoc = null;
			const fresh = await getNote(g);
			if (!fresh) return;
			if (fresh.xmlContent === note?.xmlContent) return;
			note = fresh;
			// Swap content prop — TomboyEditor's $effect keyed on `content`
			// performs the setContent + clearDirty dance. Fingerprint reset
			// so the reloaded doc isn't immediately re-saved.
			editorContent = getNoteEditorContent(fresh);
			lastSavedDocFingerprint = null;
		});
		return off;
	});

	// Route 변경 시 에디터 콘텐츠 교체
	//
	// The TomboyEditor instance is created on first load and kept alive
	// for every subsequent note navigation — only its `content` /
	// `currentGuid` props change, which the editor reacts to internally
	// via setContent(). We deliberately do NOT clear `editorContent` /
	// `note` / `loading` here: those fields drive the conditional that
	// mounts the editor, and toggling them would force a remount (the
	// old pattern that this K-optimization undoes).
	$effect(() => {
		const id = noteId;
		if (!id || id === loadedGuid) return;
		loadedGuid = id;
		// New note → previous fingerprint doesn't apply anymore.
		lastSavedDocFingerprint = null;

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

			isScrollBottomState = await isScrollBottomNote(id);
			if (isScrollBottomState) {
				// Wait for the editor to apply the new doc + layout before
				// scrolling. Two rAFs is enough with the reused-editor
				// model (setContent is synchronous but layout needs a
				// frame).
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (id !== noteId) return;
						scrollEditorToBottom();
					});
				});
			}
		})();
	});

	function scrollEditorToBottom() {
		const el = editorAreaEl;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}

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
		// Cheap no-op gate: if the doc matches what we last persisted, skip
		// the whole save path (IDB read + XML serialize + compare). Missing
		// a real change here is a correctness bug, so the fingerprint must
		// be a proper content hash; native JSON.stringify is fast enough
		// and runs at most once per 1.5s save debounce.
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

	/**
	 * After a slip-note chain op mutates the current note's xmlContent in
	 * IDB, the editor still holds the old doc. Flush any pending user edits
	 * first (so we don't clobber them), then replace the editor content
	 * from the fresh note.
	 */
	async function reloadCurrentNoteFromIdb(): Promise<void> {
		if (!note) return;
		const fresh = await getNote(note.guid);
		if (!fresh) return;
		note = fresh;
		editorContent = getNoteEditorContent(fresh);
		lastSavedDocFingerprint = null;
		const ed = getEditor();
		if (ed && editorContent) {
			ed.commands.setContent(editorContent, { emitUpdate: false });
		}
	}

	async function flushBeforeOp(): Promise<void> {
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
	}

	async function handleSlipInsertAfter() {
		if (!note) return;
		try {
			await flushBeforeOp();
			const { newGuid } = await insertNewNoteAfter(note.guid);
			goto(`/note/${newGuid}`);
		} catch (e) {
			pushToast((e as Error).message ?? '새 슬립노트 추가 실패', { kind: 'error' });
		}
	}

	async function handleSlipCut() {
		if (!note) return;
		try {
			await flushBeforeOp();
			await cutFromChain(note.guid);
			slipClipboard.setCut(note.guid);
			await reloadCurrentNoteFromIdb();
			pushToast('슬립노트 체인에서 잘라냈습니다.');
		} catch (e) {
			pushToast((e as Error).message ?? '잘라내기 실패', { kind: 'error' });
		}
	}

	async function handleSlipConnect() {
		if (!note) return;
		try {
			await flushBeforeOp();
			await disconnectFromPrev(note.guid);
			slipClipboard.setConnect(note.guid);
			await reloadCurrentNoteFromIdb();
			pushToast('다른 곳에 연결할 준비가 됐습니다. 대상 노트에서 붙여넣으세요.');
		} catch (e) {
			pushToast((e as Error).message ?? '연결 준비 실패', { kind: 'error' });
		}
	}

	async function handleSlipPaste() {
		if (!note) return;
		const g = slipClipboard.guid;
		const mode = slipClipboard.mode;
		if (!g || g === note.guid || !mode) return;
		try {
			await flushBeforeOp();
			if (mode === 'cut') {
				await pasteAfter(g, note.guid);
			} else {
				await connectAfter(g, note.guid);
			}
			slipClipboard.clear();
			await reloadCurrentNoteFromIdb();
			pushToast(
				mode === 'cut'
					? '슬립노트를 이 노트 뒤에 붙여넣었습니다.'
					: '슬립노트 체인을 이 노트 뒤에 연결했습니다.'
			);
		} catch (e) {
			pushToast((e as Error).message ?? '붙여넣기 실패', { kind: 'error' });
		}
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

		if (kind === 'compareWithServer') {
			goto(`/note/${note!.guid}/compare`);
			return;
		}

		if (kind === 'toggleScrollBottom') {
			const next = !isScrollBottomState;
			await setScrollBottomNote(note!.guid, next);
			isScrollBottomState = next;
			pushToast(next ? '이 노트는 열 때 항상 맨 아래로 이동합니다.' : '맨 아래 이동이 해제되었습니다.');
			if (next) scrollEditorToBottom();
			return;
		}
	}

	async function gotoRandom() {
		const all = (await listNotes()).filter((n) => !n.deleted && n.guid !== noteId);
		if (all.length === 0) return;
		const picked = all[Math.floor(Math.random() * all.length)];
		goto(`/note/${picked.guid}?from=home`);
	}

	function todayTitle(): string {
		const d = new Date();
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	async function gotoToday() {
		const title = todayTitle();
		const existing = await findNoteByTitle(title);
		if (existing && !existing.deleted) {
			if (existing.guid === noteId) return;
			goto(`/note/${existing.guid}?from=home`);
			return;
		}
		const created = await createNote(title);
		goto(`/note/${created.guid}?from=home`);
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

	<div class="editor-area" bind:this={editorAreaEl}>
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if editorContent}
			<!--
				No {#key noteId} — TomboyEditor stays mounted across note
				navigations and reacts to `content` / `currentGuid` prop
				changes internally via setContent(). Destroying and
				recreating the editor on every transition rebuilt the PM
				schema + all extensions + DOM and was the dominant cost
				in "open a new note" lag.
			-->
			<TomboyEditor
				bind:this={editorComponent}
				content={editorContent}
				onchange={handleEditorChange}
				oninternallink={handleInternalLink}
				currentGuid={noteId}
				createDate={note?.createDate ?? null}
				isSlipNote={isSlipNote}
				onslipnavigate={handleInternalLink}
				oninsertafter={handleSlipInsertAfter}
				oncut={handleSlipCut}
				onconnect={handleSlipConnect}
				onpaste={handleSlipPaste}
				canPasteSlip={canPasteSlip}
				cutSlipTitle={cutSlipTitle}
				slipClipboardMode={slipClipboardMode}
			/>
		{/if}
	</div>

	<div class="toolbar-area">
		<Toolbar
			editor={getEditor()}
			onextractnote={handleExtractNote}
			onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
		/>
	</div>

	{#if isFromHome}
		<button class="fab-today" onclick={gotoToday} aria-label="오늘 날짜 노트">📅</button>
		<button class="fab-random" onclick={gotoRandom} aria-label="랜덤 노트">🎲</button>
	{/if}
</div>

{#if actionSheetOpen && note}
	<NoteActionSheet
		{note}
		dirty={!!(pendingDoc || saving)}
		isFavoriteNote={isFavoriteNote}
		isHomeNote={isHomeNoteState}
		isScrollBottomNote={isScrollBottomState}
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
		/* Size container for image previews (max-height: 100cqh inside
		   TomboyEditor). Safe here: .editor-area has a definite height
		   via flex:1 in the .editor-page flex column. */
		container-type: size;
	}

	.toolbar-area {
		flex-shrink: 0;
		background: #f8f9fa;
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--color-text-secondary);
	}

	.fab-random {
		position: absolute;
		bottom: 88px;
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

	.fab-today {
		position: absolute;
		bottom: calc(88px + 56px);
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

	.fab-today:active {
		transform: scale(0.93);
	}
</style>
