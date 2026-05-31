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
	import { subscribeNoteReload } from '$lib/core/noteReloadBus.js';
	import { attachOpenNote, detachOpenNote } from '$lib/sync/firebase/orchestrator.js';
	import type { NoteData } from '$lib/core/note.js';
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
	import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';
	import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';
	import { runOcrInEditor } from '$lib/ocrNote/runOcrInEditor.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';
	import NoteContextMenu, { type ActionKind } from '$lib/editor/NoteContextMenu.svelte';
	import NoteXmlViewer from '$lib/editor/NoteXmlViewer.svelte';
	import {
		assignNotebook,
		createNotebook,
		getNotebook,
		listNotebooks
	} from '$lib/core/notebooks.js';
	import { setHomeNote, clearHomeNote, getHomeNoteGuid } from '$lib/core/home.js';
	import { getScheduleNoteGuid } from '$lib/core/schedule.js';
	import { isScrollBottomNote, setScrollBottomNote } from '$lib/core/scrollBottom.js';
	import { pushToast, dismissToast } from '$lib/stores/toast.js';
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
		registerReloadHook,
		desktopSession
	} from './session.svelte.js';
	import { modKeys } from './modKeys.svelte.js';
	import { SEND_SOURCE_GUID } from '$lib/editor/sendListItem/transferListItem.js';
	import { shouldSendListBeActive } from '$lib/editor/sendListItem/sendActiveGate.js';
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
	import { createTitleProvider } from '$lib/editor/autoLink/titleProvider.js';
	import { findAdjacentDateNotes } from '$lib/editor/dateLink/findAdjacentDateNotes.js';

	interface Props {
		guid: string;
		x: number;
		y: number;
		width: number;
		height: number;
		z: number;
		pinned?: boolean;
		/** True when this window's workspace is the currently visible one.
		 *  Hidden (`active=false`) windows still hold their TipTap / terminal
		 *  state in memory, but skip Firebase attach and global editor
		 *  registration so they aren't mistaken for the user's focus target. */
		active?: boolean;
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
		active = true,
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
	let menuAnchor = $state<{ right: number; bottom: number } | null>(null);
	let xmlViewerOpen = $state(false);
	let notebookNames = $state<string[]>([]);
	let isHomeState = $state(false);
	let isScrollBottomState = $state(false);
	let isScheduleNote = $state(false);
	let windowEl: HTMLDivElement | undefined = $state(undefined);
	let terminalSpec: TerminalNoteSpec | null = $state.raw(null);
	let terminalConnectMode = $state(false);
	const showTerminal = $derived(!!terminalSpec && terminalConnectMode);
	let keysSpec: KeysNoteSpec | null = $state.raw(null);
	let keysConnectMode = $state(false);
	const showKeys = $derived(!!keysSpec && keysConnectMode);

	// Bridge settings for ChatSendBar — loaded once on mount from appSettings.
	let llmBridgeUrl = $state('');
	let llmBridgeToken = $state('');

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingDoc: JSONContent | null = $state.raw(null);
	// Fingerprint of the last successfully-flushed doc. flushSave() skips
	// the whole save pipeline (IDB read + XML serialize) when the incoming
	// doc stringifies identically — catches the type-and-undo case cheaply.
	let lastSavedDocFingerprint: string | null = null;
	let flushChain: Promise<void> = Promise.resolve();

	const isFavoriteState = $derived(note ? isFavorite(note) : false);
	const currentNotebook = $derived(note ? getNotebook(note) : null);
	const isSlipNote = $derived(currentNotebook === SLIPBOX_NOTEBOOK);
	const sendActive = $derived(
		shouldSendListBeActive({
			guid,
			sourceGuid: SEND_SOURCE_GUID,
			ctrlHeld: modKeys.ctrl,
			focusedGuid: desktopSession.focusedNoteGuid
		})
	);
	const canPasteSlip = $derived(
		isSlipNote && slipClipboard.hasEntry && slipClipboard.guid !== guid
	);
	const slipClipboardMode = $derived(slipClipboard.mode);
	let cutSlipTitle = $state<string | null>(null);
	$effect(() => {
		const g = slipClipboard.guid;
		if (!g) { cutSlipTitle = null; return; }
		getNote(g).then((n) => { cutSlipTitle = n?.title ?? null; });
	});

	// Slip-note category label resolved from the slip-box index. See the
	// mobile route for the matching effect; we keep them parallel so the
	// placeholder works the same in both surfaces.
	let slipNoteLabel = $state<string | null>(null);
	$effect(() => {
		void note?.title;
		if (!isSlipNote) { slipNoteLabel = null; return; }
		let cancelled = false;
		getSlipNoteLabel(guid)
			.then((label) => { if (!cancelled) slipNoteLabel = label; })
			.catch(() => { if (!cancelled) slipNoteLabel = null; });
		return () => { cancelled = true; };
	});

	// Date-arrow adjacency — prev/next titles for yyyy-mm-dd-titled notes.
	let dateAdjacency = $state<{ prev: string | null; next: string | null }>({
		prev: null,
		next: null
	});
	let dateTitleProvider: ReturnType<typeof createTitleProvider> | null = null;

	function recomputeDateAdjacency(): void {
		const t = note?.title;
		if (!t || !dateTitleProvider) {
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
		dateAdjacency = findAdjacentDateNotes(t, guid, titles);
	}

	function getEditor(): Editor | null {
		return editorComponent?.getEditor() ?? null;
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

		(async () => {
			const loaded = await getNote(guid);
			if (!loaded) {
				loading = false;
				return;
			}
			note = loaded;
			editorContent = getNoteEditorContent(loaded);
			terminalSpec = parseTerminalNote(editorContent);
			terminalConnectMode = false;
			keysSpec = parseKeysNote(editorContent);
			keysConnectMode = false;
			loading = false;

			const homeGuid = await getHomeNoteGuid();
			isHomeState = homeGuid === guid;

			const schedGuid = await getScheduleNoteGuid();
			isScheduleNote = schedGuid === guid;

			notebookNames = await listNotebooks();

			isScrollBottomState = await isScrollBottomNote(guid);
			if (isScrollBottomState) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => scrollEditorToBottom());
				});
			}
		})();

		// Register a flush hook so closeWindow() can persist unsaved edits.
		// Stays registered for the window's entire lifetime so multi-window
		// ops (`flushAll`) can drain pending edits even from windows whose
		// workspace isn't currently visible.
		const unregisterFlush = registerFlushHook(guid, () => flushSave());
		// Register a reload hook so cross-window ops (slip-note chain
		// splicing) can force this window to drop stale editor state
		// and pick up neighbor-field updates the op wrote to IDB.
		const unregisterReload = registerReloadHook(guid, () => externalReload());

		dateTitleProvider = createTitleProvider();
		void Promise.all([
			dateTitleProvider.refresh(),
			slipNoteGuids.refresh()
		]).then(() => recomputeDateAdjacency());
		const offDateChange = dateTitleProvider.onChange(() => recomputeDateAdjacency());
		const offSlipChange = slipNoteGuids.onChange(() => recomputeDateAdjacency());

		return () => {
			unregisterFlush();
			unregisterReload();
			offDateChange();
			offSlipChange();
			dateTitleProvider?.dispose();
			dateTitleProvider = null;
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
				// Best-effort final save; we don't await since onMount cleanup is sync.
				void flushSave();
			}
		};
	});

	// Realtime Firebase sync attach/detach is gated on `active` so a
	// hidden workspace's note window doesn't keep an onSnapshot open. The
	// effect cleanup also runs on real unmount (close button), so an
	// explicit detach in onMount cleanup isn't needed.
	$effect(() => {
		if (!active) return;
		attachOpenNote(guid);
		return () => detachOpenNote(guid);
	});

	// Recompute adjacency when the current note's title changes (rename,
	// slip-note chain op rewriting neighbours, etc.).
	$effect(() => {
		void note?.title;
		recomputeDateAdjacency();
	});

	// Register the Tiptap editor with the session so global shortcuts
	// (Ctrl+L) can access the current selection. Hidden workspace windows
	// don't register — otherwise two windows for the same guid (one per
	// workspace) would collide in the registry's last-write-wins map and
	// `getFocusedEditor` could resolve to an off-screen instance.
	$effect(() => {
		if (!active) return;
		const ec = editorComponent;
		if (!ec) return;
		const editor = ec.getEditor();
		if (!editor) return;
		const off = desktopSession.registerEditor(guid, editor);
		return off;
	});

	// Subscribe to the note reload bus for this window's guid. Fires when
	// another note's rename rewrote a <link:internal>Oldtitle</link:internal>
	// mark inside THIS note's xml — we need to drop the pendingDoc (which
	// still carries the old title) and refresh from IDB so the next
	// debounced save doesn't clobber the sweep's fix. Independent of
	// session.svelte.ts's reloadHooks (those are for slip-note chain ops).
	$effect(() => {
		const g = guid;
		const off = subscribeNoteReload(g, async () => {
			await externalReload();
		});
		return off;
	});

	function handleEditorChange(doc: JSONContent) {
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void flushSave();
		}, 1500);
	}

	/**
	 * Resize the window so each split column keeps roughly the original
	 * note width. Active divider count goes prev → next; the window's
	 * width scales by (next + 1) / (prev + 1):
	 *
	 *   0 → 1 divider (1 col → 2 cols): ratio 2/1 = 2x       ("2배")
	 *   1 → 2 dividers (2 cols → 3 cols): ratio 3/2 = +50%   ("50%가 늘어나고")
	 *   2 → 3 dividers (3 cols → 4 cols): ratio 4/3
	 *   ...and symmetric for toggle-off.
	 *
	 * The transition delta — not an absolute "base width" — drives the
	 * resize, so manual user resizes between toggles are preserved
	 * proportionally.
	 */
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

	function handleHrSplitChange(newCount: number, prevCount: number) {
		const ratio = (newCount + 1) / (prevCount + 1);
		if (!Number.isFinite(ratio) || ratio === 1) return;
		const newWidth = Math.max(
			DESKTOP_WINDOW_MIN_WIDTH,
			Math.round(width * ratio)
		);
		desktopSession.updateGeometry(guid, { x, y, width: newWidth, height });
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
			const updated = await updateNoteFromEditor(note.guid, pendingDoc);
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
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		onopenlink(title);
	}

	// Slip-note 화살표는 직접 `openRightOf`로 흘려서, "다음" 클릭 시
	// 체인이 왼→오 방향으로 겹치지 않게 펼쳐지도록 한다. "이전"은
	// 기존 내부 링크 열기(이미 열려 있으면 포커스만 이동)로 처리.
	// `replace` (Ctrl/Cmd-click)는 이 창을 닫고 그 자리에 다음 노트를 연다.
	async function handleSlipNavigate(
		target: string,
		direction: 'prev' | 'next',
		replace: boolean
	) {
		const title = target.trim();
		if (!title) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		if (replace) {
			await desktopSession.openReplacing(guid, title);
		} else if (direction === 'next') {
			await desktopSession.openRightOf(guid, title);
		} else {
			onopenlink(title);
		}
	}

	// Date-arrow navigation: symmetric cascade — "next" opens to the right
	// of the source, "prev" to the left. Both reposition the target window
	// even when it's already open, so the flow stays visually contiguous.
	// `replace` (Ctrl/Cmd-click)는 이 창을 닫고 그 자리에 다음 노트를 연다.
	async function handleDateNavigate(
		target: string,
		direction: 'prev' | 'next',
		replace: boolean
	) {
		const title = target.trim();
		if (!title) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		if (replace) {
			await desktopSession.openReplacing(guid, title);
		} else if (direction === 'next') {
			await desktopSession.openRightOf(guid, title);
		} else {
			await desktopSession.openLeftOf(guid, title);
		}
	}

	async function flushBeforeOp(): Promise<void> {
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		await flushSave();
	}

	async function reloadFromIdb(): Promise<void> {
		if (!note) return;
		const fresh = await getNote(note.guid);
		if (!fresh) return;
		note = fresh;
		editorContent = getNoteEditorContent(fresh);
		terminalSpec = parseTerminalNote(editorContent);
		if (!terminalSpec) terminalConnectMode = false;
		keysSpec = parseKeysNote(editorContent);
		if (!keysSpec) keysConnectMode = false;
		lastSavedDocFingerprint = null;
		const ed = getEditor();
		if (ed && editorContent) {
			ed.commands.setContent(editorContent, { emitUpdate: false });
		}
	}

	/**
	 * Called when another window's op has rewritten this note in IDB.
	 * We cancel any pending debounced save (its doc is stale — the
	 * fresh IDB content wins) and then reload as normal.
	 */
	async function externalReload(): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		pendingDoc = null;
		await reloadFromIdb();
	}

	async function handleSlipInsertAfter() {
		if (!note) return;
		try {
			// Flush every open window so the op reads the freshest state
			// and no other window has a stale pendingDoc waiting to land.
			await desktopSession.flushAll();
			const { newGuid, affectedGuids } = await insertNewNoteAfter(note.guid);
			// Reload every affected open window (including this one) so
			// neighbor-field writes aren't silently overwritten by a
			// lingering pendingDoc somewhere.
			await desktopSession.reloadWindows(affectedGuids);
			desktopSession.openWindow(newGuid);
		} catch (e) {
			pushToast((e as Error).message ?? '새 슬립노트 추가 실패', { kind: 'error' });
		}
	}

	async function handleSlipCut() {
		if (!note) return;
		try {
			await desktopSession.flushAll();
			const { affectedGuids } = await cutFromChain(note.guid);
			slipClipboard.setCut(note.guid);
			await desktopSession.reloadWindows(affectedGuids);
			pushToast('슬립노트 체인에서 잘라냈습니다.');
		} catch (e) {
			pushToast((e as Error).message ?? '잘라내기 실패', { kind: 'error' });
		}
	}

	async function handleSlipConnect() {
		if (!note) return;
		try {
			await desktopSession.flushAll();
			const { affectedGuids } = await disconnectFromPrev(note.guid);
			slipClipboard.setConnect(note.guid);
			await desktopSession.reloadWindows(affectedGuids);
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
			await desktopSession.flushAll();
			const { affectedGuids } =
				mode === 'cut'
					? await pasteAfter(g, note.guid)
					: await connectAfter(g, note.guid);
			slipClipboard.clear();
			await desktopSession.reloadWindows(affectedGuids);
			pushToast(
				mode === 'cut'
					? '슬립노트를 이 노트 뒤에 붙여넣었습니다.'
					: '슬립노트 체인을 이 노트 뒤에 연결했습니다.'
			);
		} catch (e) {
			pushToast((e as Error).message ?? '붙여넣기 실패', { kind: 'error' });
		}
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
		// A hidden workspace window must never steal focus. Same guid open
		// in two workspaces is rare but possible; only the active one
		// should react to the focusRequest.
		if (!active) return;
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
			bottom: Math.max(4, window.innerHeight - rect.top + 4)
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
			const nowFav = toggleFavorite(note.guid);
			pushToast(nowFav ? '즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 제거되었습니다.');
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

		if (kind === 'viewXml') {
			xmlViewerOpen = true;
			return;
		}
	}

	async function handleNotebookChange(e: Event) {
		const select = e.currentTarget as HTMLSelectElement;
		const value = select.value;
		const prev = currentNotebook;

		if (value === '__new__') {
			// Reset the select back to the current value while we prompt.
			select.value = prev ?? '';
			const raw = window.prompt('새 노트북 이름');
			const name = raw?.trim();
			if (!name) return;
			try {
				await createNotebook(name);
			} catch (err) {
				pushToast((err as Error).message || '노트북을 만들 수 없습니다.', { kind: 'error' });
				return;
			}
			notebookNames = await listNotebooks();
			await applyNotebook(name);
			return;
		}

		const next = value === '' ? null : value;
		await applyNotebook(next);
	}

	async function applyNotebook(name: string | null) {
		if (!note) return;
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
			await flushSave();
		}
		await assignNotebook(note.guid, name);
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		pushToast('노트북이 변경되었습니다.');
	}

	function handleActionGoto(targetGuid: string) {
		menuAnchor = null;
		desktopSession.openWindow(targetGuid);
	}

	const titleDisplay = $derived(note?.title?.trim() || '제목 없음');
	const isFocused = $derived(desktopSession.focusedNoteGuid === guid);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={windowEl}
	class="note-window"
	class:hidden={!active}
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

	<div class="body" class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}>
		{#if loading}
			<div class="loading">로딩 중...</div>
		{:else if showTerminal && terminalSpec}
			{#key guid}
				<TerminalView
					spec={terminalSpec}
					{guid}
					onedit={() => (terminalConnectMode = false)}
				/>
			{/key}
		{:else if showKeys && keysSpec}
			{#key guid}
				<KeysView
					spec={keysSpec}
					{guid}
					onedit={() => (keysConnectMode = false)}
				/>
			{/key}
		{:else}
			{#if editorContent}
				<TomboyEditor
					bind:this={editorComponent}
					content={editorContent}
					onchange={handleEditorChange}
					oninternallink={handleInternalLink}
					currentGuid={guid}
					enableContextMenu={true}
					createDate={note?.createDate ?? null}
					slipNoteLabel={slipNoteLabel}
					sendListItemActive={sendActive}
					isScheduleNote={isScheduleNote}
					isSlipNote={isSlipNote}
					onslipnavigate={handleSlipNavigate}
					oninsertafter={handleSlipInsertAfter}
					oncut={handleSlipCut}
					onconnect={handleSlipConnect}
					onpaste={handleSlipPaste}
					canPasteSlip={canPasteSlip}
					cutSlipTitle={cutSlipTitle}
					slipClipboardMode={slipClipboardMode}
					prevDateTitle={dateAdjacency.prev}
					nextDateTitle={dateAdjacency.next}
					ondatenavigate={handleDateNavigate}
					noteFocused={isFocused}
					onhrsplitchange={handleHrSplitChange}
					onimageinserted={handleImageInserted}
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
			{:else}
				<div class="loading">노트를 불러올 수 없습니다.</div>
			{/if}
		{/if}
	</div>

	{#if terminalSpec && !showTerminal}
		<button
			type="button"
			class="fab-terminal-connect"
			class:above-toolbar={isFocused}
			onclick={() => (terminalConnectMode = true)}
			aria-label="SSH 접속"
			title="SSH 접속 — {terminalSpec.target}"
			data-no-drag
		>접속</button>
	{/if}

	{#if keysSpec && !showKeys}
		<button
			type="button"
			class="fab-terminal-connect"
			class:above-toolbar={isFocused}
			onclick={() => (keysConnectMode = true)}
			aria-label="키 패드"
			title="키 이벤트 — {keysSpec.raw}"
			data-no-drag
		>키</button>
	{/if}

	{#if !loading && editorContent && isFocused && !showTerminal && !showKeys}
		<div class="toolbar-slot">
			<Toolbar
				editor={getEditor()}
				onuploadimage={(file) => editorComponent?.uploadAndInsertImage(file)}
				onuploadfile={(file) => editorComponent?.uploadAndInsertFile(file)}
				onfind={() => editorComponent?.openFind()}
			/>
			{#if note}
				<div class="toolbar-right">
					<select
						class="notebook-select"
						value={currentNotebook ?? ''}
						onchange={handleNotebookChange}
						aria-label="노트북"
						title="노트북"
					>
						<option value="">없음</option>
						{#each notebookNames as n (n)}
							<option value={n}>🗂 {n}</option>
						{/each}
						<option value="__new__">+ 새 노트북…</option>
					</select>
					<button
						type="button"
						class="menu-btn"
						onclick={openMenu}
						aria-label="더 보기"
						title="더 보기"
					>⋯</button>
				</div>
			{/if}
		</div>
	{/if}

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

{#if xmlViewerOpen && note}
	<NoteXmlViewer
		title={note.title}
		xml={note.xmlContent}
		onclose={() => (xmlViewerOpen = false)}
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
		/* Toolbar floats at the bottom; body reserves this much padding
		   unconditionally so note content never hides behind it, even when
		   unfocused (toolbar hidden). */
		--toolbar-h: 30px;
	}

	/* Windows belonging to an inactive workspace stay mounted so editor
	   state and terminal connections survive workspace switches, but are
	   completely hidden from layout, hit-testing, and focus. */
	.note-window.hidden {
		display: none;
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
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: var(--toolbar-h);
		display: flex;
		align-items: stretch;
		border-top: 1px solid #dee2e6;
		background: #f8f9fa;
	}

	/* Left side: formatting buttons. Grow to push the right group flush
	   right; shrink first when the window narrows so the notebook + menu
	   stay visible. The drawer inside keeps its own overflow-x scroll. */
	.toolbar-slot :global(.toolbar-wrap) {
		flex: 1 1 0;
		min-width: 0;
		border-top: none;
	}

	/* Right side: notebook chip + ⋯ menu. Never shrinks — these are the
	   user's primary affordances on the bottom bar. */
	.toolbar-right {
		flex-shrink: 0;
		display: flex;
		align-items: stretch;
		border-left: 1px solid #e9ecef;
	}

	.menu-btn {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		margin: 0px 8px 0px 4px;
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

	.notebook-select {
		flex-shrink: 0;
		align-self: center;
		max-width: 140px;
		margin: 0px 2px 0px 8px;
		padding: 4px 6px;
		border: 1px solid #ced4da;
		border-radius: 6px;
		background: #fff;
		color: #212529;
		font-size: 0.82rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.notebook-select:hover {
		border-color: #adb5bd;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.body :global(.tomboy-editor-shell) {
		flex: 1;
		min-height: 0;
	}

	/* desktop window 는 body scroll 이 없고 (chromeless) 윈도우 박스 안에서
	   자체 scroll 해야 함. TomboyEditor 컴포넌트 자체는 모바일 body-scroll
	   모델로 동작하므로 desktop 안에서만 inner scroll 을 복구. */
	.body :global(.tomboy-editor) {
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	/* Bottom margin lives INSIDE the editor's scrollable content (on the
	   ProseMirror root), so scrolling to the bottom reveals empty space
	   under the last line — the floating toolbar overlays that space
	   instead of hiding text. Always present regardless of focus. */
	.body :global(.tomboy-editor .tiptap) {
		padding-bottom: var(--toolbar-h);
	}

	.loading {
		padding: 24px;
		text-align: center;
		color: #888;
	}

	/* Gray surface signals "this is a terminal note" while the user is in
	   edit mode. The floating 접속 button is the primary action. */
	.body.terminal-edit {
		background: #e8e8e8;
	}

	.fab-terminal-connect {
		position: absolute;
		right: 16px;
		bottom: 16px;
		min-width: 56px;
		height: 40px;
		padding: 0 14px;
		border-radius: 20px;
		border: none;
		background: #fff;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
		font-size: 0.9rem;
		font-weight: 600;
		color: #222;
		cursor: pointer;
		z-index: 5;
	}

	/* When the focused-window toolbar is visible at the bottom, lift the
	   FAB above it so it doesn't overlap. --toolbar-h is 30px. */
	.fab-terminal-connect.above-toolbar {
		bottom: calc(var(--toolbar-h) + 12px);
	}

	.fab-terminal-connect:hover {
		background: #f5f5f5;
	}

	.fab-terminal-connect:active {
		transform: scale(0.96);
	}

</style>
