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
		listNotes,
		renameNote
	} from '$lib/core/noteManager.js';
	import { subscribeNoteReload, subscribeNoteFlush } from '$lib/core/noteReloadBus.js';
	import { attachOpenNote, detachOpenNote } from '$lib/sync/firebase/orchestrator.js';
	import type { NoteData } from '$lib/core/note.js';
	import { createTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
	import { isEditorAreaWhitespaceClick } from '$lib/editor/editorAreaClick.js';
	import { cursorDebug } from '$lib/stores/cursorDebug.svelte.js';
	import { findAdjacentDateNotes } from '$lib/editor/dateLink/findAdjacentDateNotes.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import Toolbar from '$lib/editor/Toolbar.svelte';
	import TerminalView from '$lib/editor/terminal/TerminalView.svelte';
	import {
		parseTerminalNote,
		type TerminalNoteSpec
	} from '$lib/editor/terminal/parseTerminalNote.js';
	import KeysView from '$lib/editor/keyRemote/KeysView.svelte';
	import { parseKeysNote, type KeysNoteSpec } from '$lib/editor/keyRemote/parseKeysNote.js';
	import ChatSendBar from '$lib/editor/chatNote/ChatSendBar.svelte';
	import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
	import { isMusicNoteDoc } from '$lib/music/parseMusicNote.js';
	import { musicPlayer } from '$lib/music/musicPlayer.svelte.js';
	import { resumePlaybackFromGesture } from '$lib/music/musicAudio.svelte.js';
	import { getGlobalLatest, getLocalLatest, resumeGlobalLatest } from '$lib/music/musicControl.svelte.js';
	import {
		MUSIC_CONTROL_GUID,
		parseRecordsFromXml
	} from '$lib/music/musicControlNote.js';
	import MusicControlView from '$lib/editor/musicControlNote/MusicControlView.svelte';
	import { continuityChoice } from '$lib/music/continuity.js';
	import MusicContinuityPicker from '$lib/editor/musicNote/MusicContinuityPicker.svelte';
	import NoteBundleStack from '$lib/editor/noteBundle/NoteBundleStack.svelte';
	import NoteBundleCabinet from '$lib/editor/noteBundle/NoteBundleCabinet.svelte';
	import BacklinkBundleOverlay from '$lib/editor/noteBundle/BacklinkBundleOverlay.svelte';
	import {
		dedicatedBundleKind,
		parseDedicatedBundle
	} from '$lib/editor/noteBundle/parser.js';
	import TallyNote from '$lib/editor/tallyNote/TallyNote.svelte';
	import { isTallyTitle, parseTallyNote } from '$lib/tally';
	import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';
	import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';
	import { runOcrInEditor } from '$lib/ocrNote/runOcrInEditor.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';
	import NoteActionSheet, { type ActionKind } from '$lib/editor/NoteActionSheet.svelte';
	import NoteXmlViewer from '$lib/editor/NoteXmlViewer.svelte';
	import NotebookPicker from '$lib/components/NotebookPicker.svelte';
	import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';
	import NoteDragHandle from '$lib/components/NoteDragHandle.svelte';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
	import { SLIPBOX_NOTEBOOK } from '$lib/sleepnote/validator.js';
	import { getSlipNoteLabel } from '$lib/sleepnote/indexLabel.js';
	import {
		insertNewNoteAfter,
		cutFromChain,
		pasteAfter,
		disconnectFromPrev,
		connectAfter
	} from '$lib/sleepnote/ops.js';
	import { slipClipboard } from '$lib/sleepnote/clipboard.svelte.js';
	import { slipNoteGuids } from '$lib/sleepnote/slipNoteGuids.js';
	import type { JSONContent, Editor } from '@tiptap/core';
	import { pushToast, dismissToast } from '$lib/stores/toast.js';
	import { removeNoteRevision } from '$lib/sync/manifest.js';
	import { purgeLocalOnly } from '$lib/storage/noteStore.js';
	import { invalidateCache } from '$lib/stores/noteListCache.js';
	import { sync } from '$lib/sync/syncManager.js';
	import { assignNotebook, getNotebook, listNotebooks } from '$lib/core/notebooks.js';
	import { setHomeNote, clearHomeNote, getHomeNoteGuid } from '$lib/core/home.js';
	import { mode } from '$lib/stores/guestMode.svelte.js';
	import { getCachedPublicConfig, discoverPublicConfigForGuest } from '$lib/sync/firebase/publicConfig.js';
	import { getScheduleNoteGuid } from '$lib/core/schedule.js';
	import { isScrollBottomNote, setScrollBottomNote } from '$lib/core/scrollBottom.js';
	import { modKeys, installModKeyListeners } from '$lib/desktop/modKeys.svelte.js';
	import { SEND_SOURCE_GUID } from '$lib/editor/sendListItem/transferListItem.js';
	import { shouldSendListBeActive } from '$lib/editor/sendListItem/sendActiveGate.js';

	// `$state.raw` for the large-content holders. Svelte's default deep
	// proxy traps every property read, and TipTap's Editor walks the full
	// content tree on construction (and on setContent for note switches)
	// — a 10k-node doc pays O(n) proxy allocations each time. These vars
	// are only ever reassigned (never mutated in place), so raw state is
	// both safe and significantly faster for big notes.
	let note = $state.raw<NoteData | undefined>(undefined);
	let loading = $state(true);
	let saving = $state(false);
	// Sticky title-bar height — exposed as --note-title-bar-h so the music bar
	// and StickyHeader pin BELOW the title bar instead of colliding with it.
	let titleBarHeight = $state(0);
	let editorComponent: TomboyEditor | undefined = $state(undefined);
	let editorContent: JSONContent | undefined = $state.raw(undefined);
	let actionSheetOpen = $state(false);
	let backlinkBundleOpen = $state(false);
	let pickerOpen = $state(false);
	let xmlViewerOpen = $state(false);
	let titleDialogOpen = $state(false);
	let titleDialogNotebooks = $state<string[]>([]);
	let isHomeNoteState = $state(false);
	let isScrollBottomState = $state(false);
	let isScheduleNoteState = $state(false);
	let isMusicNote = $state(false);
	let editorAreaEl: HTMLDivElement | undefined = $state(undefined);
	let toolbarAreaEl: HTMLDivElement | undefined = $state(undefined);

	// Publish the fixed toolbar's live height as `--toolbar-height` on <html>
	// and reserve that strip via `scroll-padding-bottom`, so both the browser's
	// native caret scroll-into-view and installCursorVisibility() keep the
	// cursor clear of the toolbar (which overlays the bottom of the document
	// scroll). Combined with `--keyboard-inset`, it also clears the on-screen
	// keyboard. Cleared on unmount / when the toolbar isn't shown (terminal /
	// keys views) so other routes are unaffected.
	$effect(() => {
		const el = toolbarAreaEl;
		const root = document.documentElement;
		if (!el) return;
		// Debug toggle: the scroll-padding-bottom reservation (native-scroll
		// path). --toolbar-height is published regardless — the JS nudge reads
		// it too — so only the padding is gated here.
		if (cursorDebug.scrollPadding) {
			root.style.scrollPaddingBottom =
				"calc(var(--toolbar-height, 0px) + var(--keyboard-inset, 0px))";
		} else {
			root.style.removeProperty("scroll-padding-bottom");
		}
		const sync = () =>
			root.style.setProperty("--toolbar-height", `${el.offsetHeight}px`);
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--toolbar-height");
			root.style.removeProperty("scroll-padding-bottom");
		};
	});
	// Terminal-note state: detected at note load time. `terminalConnectMode`
	// must be explicitly activated by the user (via the "접속" banner button)
	// before TerminalView mounts and opens the WS connection.
	let terminalSpec: TerminalNoteSpec | null = $state.raw(null);
	let terminalConnectMode = $state(false);
	const showTerminal = $derived(!!terminalSpec && terminalConnectMode);
	let keysSpec: KeysNoteSpec | null = $state.raw(null);
	let keysConnectMode = $state(false);
	const showKeys = $derived(!!keysSpec && keysConnectMode);

	// 전용 파일철 노트 — 제목 `탭::`/`묶음::`. 본문 전체가 파일철(터미널/음악
	// 노트처럼 풀-노트 뷰). showRawBundle = 일반 노트(링크 리스트 직접 편집)로
	// 토글; 진입은 Ctrl→편집, 복귀는 raw 뷰에서 Ctrl→↩ 묶음(모두 데스크탑).
	let showRawBundle = $state(false);
	const dedicatedKind = $derived.by(() => {
		const t = note?.title;
		return t ? dedicatedBundleKind(t) : null;
	});
	const dedicatedSpec = $derived.by(() => {
		if (!dedicatedKind || !editorContent) return null;
		return parseDedicatedBundle(editorContent, dedicatedKind);
	});
	// 집계(투표/퀴즈) 전용 노트 — 제목 `집계::`. 번들과 같은 raw 토글 패턴.
	let showRawTally = $state(false);
	const isTallyNote = $derived.by(() => {
		const t = note?.title;
		return !!t && isTallyTitle(t);
	});
	const tallySpec = $derived.by(() => {
		const t = note?.title;
		if (!t || !editorContent || !isTallyTitle(t)) return null;
		return parseTallyNote(editorContent, t);
	});
	// 노트 전환 시 항상 번들/집계 뷰로 시작(showRaw* 만 쓰고 읽지 않아 루프 없음).
	$effect(() => {
		void noteId;
		showRawBundle = false;
		showRawTally = false;
	});
	// raw→번들 복귀: 마운트된 호스트 에디터의 현재 doc 을 editorContent 로 끌어와
	// dedicatedSpec 이 최신 링크 리스트를 반영하게 한다(디바운스 저장과 별개).
	function exitRawBundle() {
		const ed = editorComponent?.getEditor();
		if (ed) editorContent = ed.getJSON();
		showRawBundle = false;
	}
	function exitRawTally() {
		const ed = editorComponent?.getEditor();
		if (ed) editorContent = ed.getJSON();
		showRawTally = false;
	}

	// Bridge settings for ChatSendBar — loaded once on mount from appSettings.
	let llmBridgeUrl = $state('');
	let llmBridgeToken = $state('');

	// Stable identity for THIS page's editor on the reload bus, so its own
	// save-convergence emit excludes itself (other editors of the same guid
	// still reload). One token for the page instance — it persists across note
	// navigations because the editor is reused (no {#key noteId}).
	const reloadToken = {};

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let loadedGuid: string | null = null;
	let pendingDoc: JSONContent | null = $state.raw(null);
	// Fingerprint of the last successfully-flushed doc. flushSave() skips
	// calling updateNoteFromEditor() when the new doc stringifies to the
	// same value — this catches the type-and-undo case without paying for
	// an IDB read + serializeContent() XML pass on every save timer tick.
	let lastSavedDocFingerprint: string | null = null;
	let flushChain: Promise<void> = Promise.resolve();

	const noteId = $derived(page.params.id);
	const isFromHome = $derived(page.url.searchParams.get('from') === 'home');
	const currentNotebook = $derived(note ? getNotebook(note) : null);

	let musicMenuOpen = $state(false);
	const musicRemote = $derived(getGlobalLatest());
	const showMusicFab = $derived(isFromHome && (musicPlayer.queue.length > 0 || musicRemote != null));

	async function pickRemoteMusic() {
		musicMenuOpen = false;
		const ok = await resumeGlobalLatest();
		if (ok && musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function pickLocalMusic() {
		musicMenuOpen = false;
		musicPlayer.resumeOrRestart();
		if (musicPlayer.isPlaying) resumePlaybackFromGesture();
	}
	function onMusicFab() {
		if (musicPlayer.isPlaying) {
			musicPlayer.pause();
			return;
		}
		const choice = continuityChoice({
			localTrackUrl: musicPlayer.currentTrack?.url ?? null,
			remoteTrackUrl: musicRemote?.trackUrl ?? null,
			localNoteGuid: musicPlayer.activeNoteGuid ?? null,
			remoteNoteGuid: musicRemote?.noteGuid ?? null,
			localUpdatedAt: getLocalLatest()?.updatedAt ?? null,
			remoteUpdatedAt: musicRemote?.updatedAt ?? null
		});
		if (choice === 'both') { musicMenuOpen = true; return; }
		if (choice === 'remote') { void pickRemoteMusic(); return; }
		pickLocalMusic();
	}
	// 음악제어::공유 — 읽기 전용 기기별 재생 상태 요약(편집 불가).
	const isMusicControlNote = $derived(note?.guid === MUSIC_CONTROL_GUID);
	const musicControlRecords = $derived(note ? parseRecordsFromXml(note.xmlContent) : []);
	const musicControlLocalDeviceId = $derived(getLocalLatest()?.deviceId ?? null);
	const isFavoriteNote = $derived(note ? isFavorite(note) : false);
	const isSlipNote = $derived(currentNotebook === SLIPBOX_NOTEBOOK);
	const canPasteSlip = $derived(
		isSlipNote && slipClipboard.hasEntry && slipClipboard.guid !== noteId
	);
	const slipClipboardMode = $derived(slipClipboard.mode);
	const sendActive = $derived(
		shouldSendListBeActive({
			guid: noteId ?? '',
			sourceGuid: SEND_SOURCE_GUID,
			ctrlHeld: modKeys.ctrl,
			focusedGuid: null,
			ignoreFocus: true
		})
	);
	let cutSlipTitle = $state<string | null>(null);
	$effect(() => {
		const g = slipClipboard.guid;
		if (!g) { cutSlipTitle = null; return; }
		getNote(g).then((n) => { cutSlipTitle = n?.title ?? null; });
	});

	// Slip-note category label — text in the index list item before the link
	// to this chain's HEAD. Resolved asynchronously after the note loads;
	// shown as the empty-second-line placeholder instead of the create date.
	let slipNoteLabel = $state<string | null>(null);
	$effect(() => {
		const id = noteId;
		void note?.title;
		if (!id || !isSlipNote) { slipNoteLabel = null; return; }
		let cancelled = false;
		getSlipNoteLabel(id)
			.then((label) => { if (!cancelled) slipNoteLabel = label; })
			.catch(() => { if (!cancelled) slipNoteLabel = null; });
		return () => { cancelled = true; };
	});

	// Date-arrow adjacency — prev/next titles for yyyy-mm-dd-titled notes.
	// Recomputed whenever the current note's title changes or the shared
	// title index refreshes (create / rename / delete anywhere in the app).
	let dateAdjacency = $state<{ prev: string | null; next: string | null }>({
		prev: null,
		next: null
	});
	let dateTitleProvider: ReturnType<typeof createTitleProvider> | null = null;

	function recomputeDateAdjacency(): void {
		const t = note?.title;
		const id = noteId;
		if (!t || !id || !dateTitleProvider) {
			dateAdjacency = { prev: null, next: null };
			return;
		}
		// Date notes never link to slip notes (and vice versa) — filter the
		// title list so a slip note with a date-format title can't be the
		// prev/next of a date note.
		const slip = slipNoteGuids.get();
		const titles = dateTitleProvider
			.getTitles()
			.filter((e) => !slip.has(e.guid));
		dateAdjacency = findAdjacentDateNotes(t, id, titles);
	}

	// Subscribe to the note reload bus for the currently-loaded guid. Fires
	// when another note's rename rewrote a <link:internal>Oldtitle</link:internal>
	// mark inside THIS note's xml — we need to drop the in-memory pendingDoc
	// (which still carries the old title) and refresh the editor from IDB,
	// otherwise the next debounced save would clobber the sweep's fix.
	$effect(() => {
		const g = note?.guid;
		if (!g) return;
		const off = subscribeNoteReload(g, async () => {
			// Don't yank an editor the user is actively typing in. flush-on-blur
			// (added in a later task) keeps only the focused editor dirty, so
			// idle siblings still reload and converge.
			const ed = editorComponent?.getEditor?.();
			if (ed?.isFocused && pendingDoc) return;
			const fresh = await getNote(g);
			if (!fresh) return;
			// No-op ping (xml unchanged): keep this editor's pending edit intact.
			if (fresh.xmlContent === note?.xmlContent) return;
			// Real change incoming — drop the stale debounced doc so it can't
			// clobber the fresh content on the next flush.
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			pendingDoc = null;
			note = fresh;
			// Swap content prop — TomboyEditor's $effect keyed on `content`
			// performs the setContent + clearDirty dance. Fingerprint reset
			// so the reloaded doc isn't immediately re-saved.
			editorContent = getNoteEditorContent(fresh);
			isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
			terminalSpec = parseTerminalNote(editorContent);
			if (!terminalSpec) terminalConnectMode = false;
			keysSpec = parseKeysNote(editorContent);
			if (!keysSpec) keysConnectMode = false;
			lastSavedDocFingerprint = null;
		}, reloadToken);
		// Flush bus: a rename sweep elsewhere flushes this editor BEFORE it
		// reads + rewrites this note, so an unsaved pending edit lands in IDB
		// first rather than being read stale and overwritten. On mobile this
		// note is almost never a backlink target of a concurrent rename, but
		// registering keeps the two surfaces symmetric with NoteWindow.
		const offFlush = subscribeNoteFlush(g, () => flushSave());
		return () => {
			off();
			offFlush();
		};
	});

	// Realtime Firebase sync attach/detach. The orchestrator no-ops when the
	// user hasn't enabled note sync, so this is cheap by default. Refcounted
	// internally — multiple windows holding the same note share one
	// subscription.
	$effect(() => {
		const id = noteId;
		if (!id) return;
		attachOpenNote(id);
		return () => detachOpenNote(id);
	});

	function isPublicForGuest(n: NoteData | undefined): boolean {
		if (!n) return false;
		const nb = getNotebook(n);
		if (!nb) return false;
		const shared = getCachedPublicConfig()?.sharedNotebooks ?? [];
		return shared.includes(nb);
	}

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
			if (mode.value === 'guest' && !isPublicForGuest(loaded)) {
				// 캐시 미스(딥링크 직후 = 공개설정 아직 미발견)면 한 번 발견을 기다린 뒤
				// 재판정. 안 그러면 IDB 에 이미 있는 노트로 빨리 들어올 때 false 로 튕긴다.
				if (!getCachedPublicConfig()) {
					try {
						await discoverPublicConfigForGuest();
					} catch {
						/* 발견 실패 → 아래에서 그대로 튕김 */
					}
					if (id !== noteId) return;
				}
				if (!isPublicForGuest(loaded)) {
					void goto('/notes', { replaceState: true });
					return;
				}
			}
			note = loaded;
			editorContent = getNoteEditorContent(loaded);
			isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
			terminalSpec = parseTerminalNote(editorContent);
			terminalConnectMode = false;
			keysSpec = parseKeysNote(editorContent);
			keysConnectMode = false;
			loading = false;

			const homeGuid = await getHomeNoteGuid();
			isHomeNoteState = homeGuid === id;

			const schedGuid = await getScheduleNoteGuid();
			isScheduleNoteState = schedGuid === id;

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
		// 모바일 route 는 body 가 scrollable — window 전체 끝으로.
		window.scrollTo(0, document.documentElement.scrollHeight);
	}

	// Tap on whitespace anywhere in the editor area → focus at end of doc.
	// Short notes leave a large empty region inside `.editor-area` below the
	// content; without this, the user has to land precisely on text to bring
	// up the keyboard. Clicks on the contenteditable (`.tiptap`), on the bars
	// mounted in this area (music / chat / remarkable — they don't
	// stopPropagation) and on any interactive element are excluded by the
	// predicate — focus('end') scrolls to the document end, so a leak here is
	// a full-page jump mid-read (see editorAreaClick.ts).
	function handleEditorAreaClick(event: MouseEvent) {
		if (!cursorDebug.whitespaceTapFocus) return; // debug toggle
		if (!isEditorAreaWhitespaceClick(event.target as Element | null)) return;
		const ed = getEditor();
		if (!ed) return;
		ed.commands.focus('end');
	}

	onMount(() => {
		// Load bridge URL and token for ChatSendBar.
		void Promise.all([
			getDefaultTerminalBridge(),
			getTerminalBridgeToken()
		]).then(([url, token]) => {
			llmBridgeUrl = url ?? '';
			llmBridgeToken = token ?? '';
		});

		const uninstallModKeys = installModKeyListeners();
		dateTitleProvider = createTitleProvider();
		void Promise.all([
			dateTitleProvider.refresh(),
			slipNoteGuids.refresh()
		]).then(() => recomputeDateAdjacency());
		const offDateChange = dateTitleProvider.onChange(() => recomputeDateAdjacency());
		const offSlipChange = slipNoteGuids.onChange(() => recomputeDateAdjacency());
		return () => {
			uninstallModKeys();
			offDateChange();
			offSlipChange();
			dateTitleProvider?.dispose();
			dateTitleProvider = null;
			if (saveTimer) {
				clearTimeout(saveTimer);
				flushSave();
			}
		};
	});

	// Recompute adjacency whenever the current note's title or the route's
	// noteId changes. The provider itself fires onChange on list mutations,
	// which is a separate path handled above.
	$effect(() => {
		void note?.title;
		void noteId;
		recomputeDateAdjacency();
	});

	function handleEditorChange(doc: JSONContent) {
		isMusicNote = isMusicNoteDoc(doc);
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => { flushSave(); }, 1500);
	}

	function flushSave(): Promise<void> {
		flushChain = flushChain.then(async () => {
			if (!pendingDoc || !note) return;
			const fingerprint = JSON.stringify(pendingDoc);
			if (fingerprint === lastSavedDocFingerprint) {
				pendingDoc = null;
				return;
			}
			saving = true;
			const updated = await updateNoteFromEditor(note.guid, pendingDoc, reloadToken);
			if (updated) note = updated;
			lastSavedDocFingerprint = fingerprint;
			pendingDoc = null;
			saving = false;
		}).catch((err) => {
			console.error('[flushSave]', err);
			saving = false;
		});
		return flushChain;
	}

	async function handleInternalLink(target: string) {
		const title = target.trim();
		if (!title) return;

		if (mode.value === 'guest') {
			const linked = await findNoteByTitle(title);
			if (!linked || !isPublicForGuest(linked)) {
				pushToast('공개되지 않은 노트입니다.', { kind: 'info' });
				return;
			}
			if (linked.guid === noteId) return;
			goto(`/note/${linked.guid}`);
			return;
		}

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

	async function handleImageInserted(url: string, file: File): Promise<void> {
		const ed = getEditor();
		if (!ed) return;
		const spec = parseOcrNote(ed.getJSON());
		if (!spec) return;
		if (!llmBridgeUrl || !llmBridgeToken) {
			pushToast('OCR 실패 — 브릿지가 설정되지 않았습니다 (설정 → 터미널)', { kind: 'error' });
			return;
		}
		const toastId = pushToast('OCR 진행 중…', { timeoutMs: 0 });
		try {
			const result = await runOcrInEditor({
				editor: ed,
				spec,
				imageUrl: url,
				imageBlob: file,
				bridgeUrl: llmBridgeUrl,
				bridgeToken: llmBridgeToken
			});
			if (result.reason === 'done') pushToast('OCR 완료');
			else if (result.reason === 'error') pushToast('OCR 오류 — 결과 영역 참고', { kind: 'error' });
		} finally {
			dismissToast(toastId);
		}
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
		isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
		terminalSpec = parseTerminalNote(editorContent);
		if (!terminalSpec) terminalConnectMode = false;
		keysSpec = parseKeysNote(editorContent);
		if (!keysSpec) keysConnectMode = false;
		lastSavedDocFingerprint = null;
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
			// purgeLocalOnly hard-deletes from IDB with no cache notification
			// of its own — invalidate so the ghost row can't linger in the
			// warm cache if the re-download sync below fails.
			invalidateCache();
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
			const nowFav = toggleFavorite(note!.guid);
			pushToast(nowFav ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
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

		if (kind === 'viewXml') {
			xmlViewerOpen = true;
			return;
		}

		if (kind === 'editTitle') {
			openTitleDialog();
			return;
		}

		if (kind === 'reflectTitle') {
			if (!note!.title.trim()) return;
			newNoteFlow.openResult({
				heading: '전체 문서에 제목 반영',
				title: note!.title,
				guid: note!.guid,
				stages: []
			});
			void newNoteFlow.startSweepCount();
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

	async function openTitleDialog() {
		titleDialogNotebooks = await listNotebooks();
		titleDialogOpen = true;
	}

	// edit 모드에선 typeId 를 쓰지 않는다(타입 변환은 범위 밖).
	async function handleTitleSave(r: { title: string; typeId: string; notebook: string | null }) {
		if (!note) return;
		titleDialogOpen = false;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
		const t0 = performance.now();
		const { ok, backlinksUpdated } = await renameNote(note.guid, r.title);
		if (!ok) {
			pushToast('이미 같은 제목의 노트가 있거나 제목이 비어 있습니다.', { kind: 'error' });
			return;
		}
		const ms = Math.round(performance.now() - t0);
		if (r.notebook !== currentNotebook) {
			await assignNotebook(note.guid, r.notebook);
		}
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		// 패널은 renameNote 의 emitNoteReload 진행 중에 열려도 안전 — 사용자가 스윕을
		// 확정하면 applySweep 가 먼저 flushAll 로 미저장 편집을 내리고, 대상 노트(이 노트)는
		// 스윕 candidates 에서 제외되므로 리로드 레이스로 내용이 깨지지 않는다.
		newNoteFlow.openResult({
			heading: '제목 변경 완료',
			title: r.title,
			guid: note.guid,
			stages: [{ name: `제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status: 'done' }]
		});
	}
</script>

<div
	class="editor-page"
	class:terminal-connected={showTerminal || showKeys}
	class:dedicated-fill={dedicatedKind && !showRawBundle}
	style="--note-title-bar-h: {titleBarHeight}px"
>
	<!-- 저장 상태 + 노트북/액션 버튼을 에디터 위 간결한 바로.
	     터미널 접속 모드에서는 숨김 — 헤더가 좁아져서 겹치고, 어차피
	     '편집 모드' 버튼으로 빠져나오면 다시 노출되니까 안전. -->
	{#if note}
		{#if !(dedicatedKind && !showRawBundle)}
			<!-- 상단 고정 타이틀바: 노트 아이콘(드래그/복사) + 제목 + 노트북/메뉴.
			     모바일은 body 가 스크롤되므로 sticky 가 TopNav 아래에 붙는다. 높이는
			     음악바/StickyHeader 오프셋용으로 --note-title-bar-h 에 노출. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="title-bar"
				bind:clientHeight={titleBarHeight}
				ondblclick={(e) => {
					if ((e.target as HTMLElement)?.closest('button')) return;
					openTitleDialog();
				}}
				title="제목 수정: 더블클릭 또는 … 메뉴"
			>
				<NoteDragHandle title={note.title ?? ''} />
				<button class="title-edit-btn" onclick={openTitleDialog} aria-label="제목 수정">✎</button>
				{#if saving}<span class="save-dot" title="저장 중"></span>{/if}
				<span class="title-text">{note.title || '제목 없음'}</span>
				<div class="title-controls">
					<button class="notebook-chip" onclick={() => (pickerOpen = true)} title="노트북">
						{#if currentNotebook}🗂 {currentNotebook}{:else}🗂{/if}
					</button>
					<button class="action-btn" onclick={() => (actionSheetOpen = true)} title="더 보기">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
							<circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
						</svg>
					</button>
				</div>
			</div>
		{:else}
			<!-- 전용 파일철 뷰(탭/묶음)는 제목을 바에 이미 노출 — 타이틀바 없음.
			     노트북/메뉴는 옛 떠있는 바로 유지(번들 UI 위에 떠야 해서 흐리게). -->
			<div class="editor-meta-bar">
				<span class="save-indicator" class:visible={saving}>저장 중...</span>
				<button class="notebook-chip" onclick={() => (pickerOpen = true)} title="노트북">
					{#if currentNotebook}🗂 {currentNotebook}{:else}🗂{/if}
				</button>
				<button class="action-btn" onclick={() => (actionSheetOpen = true)} title="더 보기">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
						<circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
					</svg>
				</button>
			</div>
		{/if}
	{/if}

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="editor-area"
		class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}
		bind:this={editorAreaEl}
		onclick={handleEditorAreaClick}
	>
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if showTerminal && terminalSpec}
			{#key noteId}
				<TerminalView
					spec={terminalSpec}
					guid={noteId ?? ''}
					onedit={() => (terminalConnectMode = false)}
				/>
			{/key}
		{:else if showKeys && keysSpec}
			{#key noteId}
				<KeysView
					spec={keysSpec}
					guid={noteId ?? ''}
					onedit={() => (keysConnectMode = false)}
				/>
			{/key}
		{:else if dedicatedKind && dedicatedSpec && !showRawBundle}
			<!-- 전용 파일철 노트 — 본문 전체가 탭/묶음. 모바일은 닫기 버튼 없음
			     (onclose 미제공). Ctrl→편집(onraw)으로 일반 노트 보기로 토글. -->
			{#key noteId}
				{#if dedicatedKind === 'bundle'}
					<NoteBundleCabinet
						spec={dedicatedSpec}
						view={null}
						hostGuid={noteId ?? null}
						variant="dedicated"
						EditorComponent={TomboyEditor}
						oninternallink={handleInternalLink}
						onraw={() => (showRawBundle = true)}
					/>
				{:else}
					<NoteBundleStack
						spec={dedicatedSpec}
						view={null}
						hostGuid={noteId ?? null}
						variant="dedicated"
						EditorComponent={TomboyEditor}
						oninternallink={handleInternalLink}
						onraw={() => (showRawBundle = true)}
					/>
				{/if}
			{/key}
		{:else if isMusicControlNote}
			<!-- 음악제어::공유 — 읽기 전용 요약. 편집기 미마운트 = 편집 불가. -->
			{#key noteId}
				<MusicControlView
					records={musicControlRecords}
					localDeviceId={musicControlLocalDeviceId}
				/>
			{/key}
		{:else if tallySpec && !showRawTally}
			<!-- 집계 전용 노트 — 본문 = 투표/퀴즈 뷰. Ctrl→편집(onraw)으로 raw 토글. -->
			{#key noteId}
				<TallyNote spec={tallySpec} guid={noteId ?? ''} onraw={() => (showRawTally = true)} />
			{/key}
		{:else}
			{#if editorContent}
				<!-- 전용 노트 raw 뷰 — Ctrl 누르면 ↩ 묶음 버튼으로 번들 뷰 복귀. -->
				{#if dedicatedKind && showRawBundle && modKeys.ctrl}
					<button class="dedicated-back-btn" onclick={exitRawBundle} title="묶음 뷰로 돌아가기"
						>↩ 묶음</button
					>
				{/if}
				{#if isTallyNote && showRawTally && modKeys.ctrl}
					<button class="dedicated-back-btn" onclick={exitRawTally} title="집계 뷰로 돌아가기"
						>↩ 집계</button
					>
				{/if}
				<!-- 재생 컨트롤은 노트 상단(제목 줄 위)에 고정 — 하단 편집 툴바를
				     가리지 않도록. editorComponent 가 바인딩된 뒤에야 렌더된다. -->
				{#if editorComponent?.getEditor() && isMusicNote}
					<MusicPlayerBar editor={editorComponent.getEditor()!} guid={noteId ?? ''} />
				{/if}
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
					onblur={() => { void flushSave(); }}
					oninternallink={handleInternalLink}
					currentGuid={noteId}
					createDate={note?.createDate ?? null}
					slipNoteLabel={slipNoteLabel}
					isSlipNote={isSlipNote}
					isScheduleNote={isScheduleNoteState}
					onslipnavigate={handleInternalLink}
					oninsertafter={handleSlipInsertAfter}
					oncut={handleSlipCut}
					onconnect={handleSlipConnect}
					onpaste={handleSlipPaste}
					canPasteSlip={canPasteSlip}
					cutSlipTitle={cutSlipTitle}
					slipClipboardMode={slipClipboardMode}
					prevDateTitle={dateAdjacency.prev}
					nextDateTitle={dateAdjacency.next}
					ondatenavigate={handleInternalLink}
					sendListItemActive={sendActive}
					hrSplitEnabled={false}
					keepCursorVisible={true}
					onimageinserted={handleImageInserted}
					hideTitleLine={true}
					onnoteready={(g) => newNoteFlow.markEditorReady(g)}
				/>
				{#if editorComponent?.getEditor() && llmBridgeUrl && llmBridgeToken}
					<ChatSendBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
					<RemarkableActionBar
						editor={editorComponent.getEditor()!}
						bridgeUrl={llmBridgeUrl}
						bridgeToken={llmBridgeToken}
					/>
				{/if}
			{/if}
		{/if}
	</div>

	{#if !showTerminal && !showKeys && !(dedicatedKind && !showRawBundle) && !(tallySpec && !showRawTally) && !isMusicControlNote}
		<!-- 전용 파일철/집계/음악제어 뷰엔 호스트 에디터가 없어 툴바가 무의미(getEditor()=null) +
		     본문을 덮음 — 숨김. raw 편집 모드에선 다시 표시. -->
		<div class="toolbar-area" bind:this={toolbarAreaEl}>
			<Toolbar
				editor={getEditor()}
				onextractnote={handleExtractNote}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
				onuploadfile={(file) => editorComponent?.uploadAndInsertFile(file)}
				onfind={() => editorComponent?.openFind()}
			/>
		</div>
	{/if}

	{#if isFromHome}
		<button class="fab-today" onclick={gotoToday} aria-label="오늘 날짜 노트">📅</button>
		<button class="fab-random" onclick={gotoRandom} aria-label="랜덤 노트">🎲</button>
	{/if}

	{#if showMusicFab}
		<button
			class="fab-music"
			onclick={onMusicFab}
			aria-label={musicPlayer.isPlaying ? '음악 일시정지' : '음악 재생'}
		>{musicPlayer.isPlaying ? '⏸' : '▶'}</button>
	{/if}

	{#if musicMenuOpen}
		<div class="music-fab-sheet" role="dialog" aria-label="재생 위치 선택">
			<MusicContinuityPicker
				localTitle={musicPlayer.currentTrack?.display ?? ''}
				remoteTitle={musicRemote?.trackTitle ?? ''}
				remoteDeviceName={musicRemote?.deviceName ?? '다른 기기'}
				onpick={(w) => (w === 'remote' ? pickRemoteMusic() : pickLocalMusic())}
				oncancel={() => (musicMenuOpen = false)}
			/>
		</div>
	{/if}

	{#if terminalSpec && !showTerminal}
		<button
			class="fab-terminal-connect"
			onclick={() => (terminalConnectMode = true)}
			aria-label="SSH 접속"
			title="SSH 접속 — {terminalSpec.target}"
		>접속</button>
	{/if}
	{#if keysSpec && !showKeys}
		<button
			class="fab-terminal-connect"
			onclick={() => (keysConnectMode = true)}
			aria-label="키 패드"
			title="키 이벤트 — {keysSpec.raw}"
		>키</button>
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
		onbacklinks={() => { actionSheetOpen = false; backlinkBundleOpen = true; }}
	/>
{/if}

{#if backlinkBundleOpen && note}
	<BacklinkBundleOverlay
		targetTitle={note.title}
		targetGuid={note.guid}
		onclose={() => (backlinkBundleOpen = false)}
		oninternallink={(t) => { backlinkBundleOpen = false; handleInternalLink(t); }}
	/>
{/if}

{#if xmlViewerOpen && note}
	<NoteXmlViewer
		title={note.title}
		xml={note.xmlContent}
		onclose={() => (xmlViewerOpen = false)}
	/>
{/if}

{#if pickerOpen && note}
	<NotebookPicker
		current={currentNotebook}
		onselect={handleNotebookSelect}
		onclose={() => (pickerOpen = false)}
	/>
{/if}

{#if titleDialogOpen && note}
	<NoteTitleDialog
		mode="edit"
		notebooks={titleDialogNotebooks}
		initialTitle={note.title}
		initialNotebook={currentNotebook}
		onsubmit={(r) => handleTitleSave(r)}
		oncancel={() => (titleDialogOpen = false)}
	/>
{/if}

<style>
	.editor-page {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		position: relative;
	}

	/* 전용 파일철 노트(`탭::`/`묶음::`) 풀-노트 뷰 — 본문 전체가 파일철 스택
	   (NoteBundleStack/Cabinet, variant="dedicated")이고 이 스택은 컨테이너를
	   .bundle-stack.dedicated{flex:1} 로 꽉 채우길 기대한다. 그런데 모바일
	   .app-shell 은 body-scroll(min-height:100dvh — 정의된 높이 없음)이라 flex:1
	   이 분배할 기준 높이가 없어 스택이 임베디드 본문 높이만큼 자라 화면을 넘긴다
	   (첫 노트 본문만 보이고 아래 타이틀 바·내부 스크롤·하단이 뷰포트 밖으로 밀림).
	   페이지를 뷰포트(- 고정 TopNav)로 못박아 정의된 높이를 주면 스택이 그 안을
	   채우고 활성 본문이 내부에서 스크롤된다. 데스크탑은 .chromeless 가 이미
	   position:fixed 로 높이를 한정하므로 무관. raw 편집(showRawBundle)은 일반
	   노트라 제외 → body-scroll 유지. */
	.editor-page.dedicated-fill {
		flex: none;
		height: calc(100dvh - var(--topnav-height, 0px));
	}
	/* 전용 노트는 하단 편집 툴바가 미렌더라 자리 확보용 padding-bottom 불필요 —
	   스택이 뷰포트 바닥까지 닿게 0. */
	.editor-page.dedicated-fill .editor-area {
		padding-bottom: 0;
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
		/* 음악 노트 상단 고정 재생바(z-index:5) 위로 떠야 노트북/메뉴 칩이
		   가려지지 않는다. */
		z-index: 6;
		pointer-events: none;
		opacity: 0.35;
		transition: opacity 0.2s;
	}

	/* Terminal-connected view owns its own toolbar; the floating
	   notebook/menu chips overlap with it on mobile. */
	.editor-page.terminal-connected .editor-meta-bar {
		display: none;
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
		min-height: 0;
		display: flex;
		flex-direction: column;
		/* 안에 absolute로 떠 있는 ChatSendBar / RemarkableActionBar 가
		   이 영역 바닥(=툴바 위)에 붙도록 컨테이닝 블록을 잡아둔다. */
		position: relative;
		/* .toolbar-area 가 fixed 로 빠져서 자리를 차지하지 않으므로
		   여기서 padding-bottom 으로 가리지 않게 자리 확보. Toolbar 한
		   row 높이 (~52px) + 약간의 여유. */
		padding-bottom: 56px;
	}

	/* Visual cue that this note is a terminal note in edit mode — the
	   floating 접속 FAB is the primary action; the gray surface signals
	   "this note has a special function" without taking vertical space. */
	.editor-area.terminal-edit {
		background: #e8e8e8;
	}

	/* 전용 노트 raw 뷰에서 Ctrl 누른 동안만 뜨는 번들 복귀 버튼 — 좌상단
	   (우상단 노트북/메뉴 칩과 겹치지 않게). */
	.dedicated-back-btn {
		position: absolute;
		top: 4px;
		left: 4px;
		z-index: 7;
		padding: 3px 9px;
		font-size: 12px;
		line-height: 1.4;
		color: #fff;
		background: rgba(38, 38, 38, 0.86);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
	}
	.dedicated-back-btn:hover {
		opacity: 0.92;
	}

	.toolbar-area {
		position: fixed;
		left: 0;
		right: 0;
		/* bottom: 0 만으로 충분. iOS Safari 는 키보드 뜨면 fixed 를
		   visual viewport 기준으로 자동으로 옮겨주고, Android Chrome
		   은 interactive-widget=resizes-content 로 layout viewport
		   자체가 키보드 위까지로 줄어듦. 둘 다 bottom:0 이 키보드
		   바로 위가 되므로 추가 inset 보정은 이중 적용이 되어 toolbar
		   가 화면 위로 점프함. */
		bottom: 0;
		z-index: 10;
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
		transition: opacity 0.15s;
	}

	.fab-random:active {
		transform: scale(0.93);
	}

	/* 에디터에 포커스가 있을 때(모바일에서 키보드가 올라와 있는 상태)에는
	   하단 FAB이 입력을 가려 방해만 되므로 숨긴다. */
	.editor-area:focus-within ~ .fab-today,
	.editor-area:focus-within ~ .fab-random,
	.editor-area:focus-within ~ .fab-music,
	.editor-area:focus-within ~ .fab-terminal-connect {
		opacity: 0;
		pointer-events: none;
	}

	.fab-music {
		position: absolute;
		bottom: calc(88px + 56px * 2);
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
		transition: opacity 0.15s;
	}
	.fab-music:active { transform: scale(0.93); }

	.music-fab-sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-sheet);
		background: var(--color-bg);
		border-top: 1px solid var(--color-border, #333);
		box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
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
		transition: opacity 0.15s;
	}

	.fab-today:active {
		transform: scale(0.93);
	}

	.fab-terminal-connect {
		position: absolute;
		bottom: 88px;
		right: 20px;
		min-width: 56px;
		height: 48px;
		padding: 0 14px;
		border-radius: 24px;
		border: none;
		background: var(--color-bg);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text, #222);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		z-index: 10;
		transition: opacity 0.15s;
	}

	.fab-terminal-connect:active {
		transform: scale(0.95);
	}

	.title-bar {
		display: flex;
		align-items: center;
		gap: clamp(4px, 1.2vw, 8px);
		padding: clamp(6px, 1.5vw, 10px) clamp(8px, 2.5vw, 14px);
		border-bottom: 1px solid var(--color-border, #eee);
		/* 상단 고정 — 모바일 body 스크롤에서 TopNav 바로 아래에 붙는다. 불투명
		   배경으로 본문이 비치지 않게. position:sticky 라 흐름에 자리를 차지해
		   첫 본문 줄을 덮지 않는다(fixed 였다면 덮음). */
		position: sticky;
		top: var(--topnav-height, 0px);
		z-index: var(--z-sticky);
		background: var(--color-bg, #fff);
		cursor: pointer;
		user-select: none;
	}
	.title-text {
		flex: 1;
		min-width: 0;
		/* 제목 느낌이 나도록 본문보다 크게. */
		font-size: clamp(1.3rem, 5.5vw, 1.7rem);
		font-weight: 700;
		line-height: 1.25;
		color: var(--color-text, #111);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.title-edit-btn {
		flex-shrink: 0;
		border: none; background: none; cursor: pointer;
		font-size: 1rem; color: var(--color-text-secondary, #888);
		padding: 4px 6px;
	}
	/* 노트북/메뉴를 타이틀바 우측에 고정 — 옛 흐린(opacity:0.35) 떠있는 바 대신
	   불투명 타이틀바 안이라 색이 선명하게 보인다. */
	.title-controls {
		display: flex;
		align-items: center;
		gap: clamp(4px, 1.2vw, 8px);
		flex-shrink: 0;
	}
	.title-bar .notebook-chip { box-shadow: none; }
	.title-bar .action-btn { background: transparent; box-shadow: none; }
	/* 저장 중 표시 — 데스크탑 NoteWindow 의 save-dot 미러. */
	.save-dot {
		flex-shrink: 0;
		width: 7px; height: 7px;
		border-radius: 50%;
		background: #f5a623;
	}
</style>
