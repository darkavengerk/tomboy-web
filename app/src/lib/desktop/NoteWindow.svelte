<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getNote,
		updateNoteFromEditor,
		getNoteEditorContent,
		deleteNoteById,
		toggleFavorite,
		isFavorite,
		renameNote
	} from '$lib/core/noteManager.js';
	import { subscribeNoteReload, subscribeNoteFlush } from '$lib/core/noteReloadBus.js';
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
	import MusicPlayerBar from '$lib/editor/musicNote/MusicPlayerBar.svelte';
	import { isMusicNoteDoc } from '$lib/music/parseMusicNote.js';
	import NoteBundleStack from '$lib/editor/noteBundle/NoteBundleStack.svelte';
	import NoteBundleCabinet from '$lib/editor/noteBundle/NoteBundleCabinet.svelte';
	import {
		dedicatedBundleKind,
		parseDedicatedBundle
	} from '$lib/editor/noteBundle/parser.js';
	import TallyNote from '$lib/editor/tallyNote/TallyNote.svelte';
	import { isTallyTitle, parseTallyNote } from '$lib/tally';
	import RemarkableActionBar from '$lib/editor/remarkable/RemarkableActionBar.svelte';
	import SendToRemarkableModal from '$lib/remarkable/SendToRemarkableModal.svelte';
	import { parseOcrNote } from '$lib/ocrNote/parseOcrNote.js';
	import { runOcrInEditor } from '$lib/ocrNote/runOcrInEditor.js';
	import {
		getDefaultTerminalBridge,
		getTerminalBridgeToken
	} from '$lib/editor/terminal/bridgeSettings.js';
	import NoteContextMenu, { type ActionKind } from '$lib/editor/NoteContextMenu.svelte';
	import NoteBackgroundPicker, { type BgSource } from './NoteBackgroundPicker.svelte';
	import BacklinkBundleOverlay from '$lib/editor/noteBundle/BacklinkBundleOverlay.svelte';
	import NoteTitleDialog from '$lib/components/NoteTitleDialog.svelte';
	import NoteDragHandle from '$lib/components/NoteDragHandle.svelte';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
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
	import { invalidateCache } from '$lib/stores/noteListCache.js';
	import { sync } from '$lib/sync/syncManager.js';
	import type { JSONContent, Editor } from '@tiptap/core';
	import { startPointerDrag } from './dragResize.js';
	import ResizeHandles from './ResizeHandles.svelte';
	import NoteBgLayer from './NoteBgLayer.svelte';
	import {
		DESKTOP_WINDOW_MIN_WIDTH,
		DESKTOP_WINDOW_MIN_HEIGHT,
		registerFlushHook,
		registerReloadHook,
		registerSnapshotSource,
		desktopSession,
		loadNoteBg,
		loadNoteBgMode,
		setNoteBg,
		clearNoteBg,
		loadNoteOpacity,
		setNoteOpacity,
		type WallpaperMode
	} from './session.svelte.js';
	import { resolveImageBlob } from '$lib/editor/imageActions/copyImage.js';
	import { getBlob } from '$lib/imageCache/imageCache.js';
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
		/** Minimized: render hidden (display:none) but stay mounted so editor /
		 *  terminal / Firebase / spread-snapshot survive. Restored from the
		 *  SidePanel 최소화됨 list or an F4-spread card click. */
		minimized?: boolean;
		onfocus: (guid: string) => void;
		onclose: (guid: string) => void;
		/** Minimize handler. Omitted by embedders without a taskbar (e.g. the
		 *  graph view) — the minimize button only renders when this is set. */
		onminimize?: (guid: string) => void;
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
		minimized = false,
		onfocus,
		onclose,
		onminimize = undefined,
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
	let bodyEl: HTMLDivElement | undefined;
	let menuAnchor = $state<{ right: number; bottom: number } | null>(null);
	let bgPickerAnchor = $state<{ right: number; bottom: number } | null>(null);
	let backlinkBundleOpen = $state(false);
	let xmlViewerOpen = $state(false);
	let sendRemarkableOpen = $state(false);
	let titleDialogOpen = $state(false);
	let notebookNames = $state<string[]>([]);
	let isHomeState = $state(false);
	let isScrollBottomState = $state(false);
	let isScheduleNote = $state(false);
	let isMusicNote = $state(false);
	let windowEl: HTMLDivElement | undefined = $state(undefined);
	// Per-note background (local-only) + window opacity. Background is a CSS
	// background on `.body` (behind the transparent editor content); opacity
	// fades the whole window so stacked notes show through.
	let noteBgUrl = $state<string | null>(null);
	let noteBgMode = $state<WallpaperMode>('contain');
	let noteOpacity = $state(1);
	let terminalSpec: TerminalNoteSpec | null = $state.raw(null);
	let terminalConnectMode = $state(false);
	const showTerminal = $derived(!!terminalSpec && terminalConnectMode);
	let keysSpec: KeysNoteSpec | null = $state.raw(null);
	let keysConnectMode = $state(false);
	const showKeys = $derived(!!keysSpec && keysConnectMode);

	// 전용 파일철 노트 — 제목 `탭::`/`묶음::`. 본문 전체가 탭/묶음(터미널/음악
	// 노트처럼 창 본문을 점유). showRawBundle = 일반 노트(링크 리스트 편집) 토글
	// — 진입 Ctrl→편집, 복귀 raw 뷰 Ctrl→↩ 묶음. 닫기(✕)는 창 닫기.
	let showRawBundle = $state(false);
	const dedicatedKind = $derived(dedicatedBundleKind(note?.title ?? ''));
	const dedicatedSpec = $derived.by(() => {
		if (!dedicatedKind || !editorContent) return null;
		return parseDedicatedBundle(editorContent, dedicatedKind);
	});
	// 집계(투표/퀴즈) 전용 노트 — 제목 `집계::`. 번들과 같은 raw 토글.
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
	// 창의 노트가 바뀌면 항상 번들/집계 뷰로 시작.
	$effect(() => {
		void guid;
		showRawBundle = false;
		showRawTally = false;
	});
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

	// Stable identity for THIS window's editor on the reload bus, so its own
	// save-convergence emit excludes itself (other editors of the same guid
	// still reload). One token per window instance.
	const reloadToken = {};

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
			isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
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
			// Revoke the live background ObjectURL (the bg effect's cleanup only
			// aborts an in-flight load; the currently-applied URL is freed here).
			if (noteBgUrl) URL.revokeObjectURL(noteBgUrl);
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

	// Register a snapshot source (gated on `active`, mirroring the editor
	// registry) so 펼쳐보기 can clone this window's live content into a
	// read-only card. Clones the `.tomboy-editor` wrapper — not the inner
	// ProseMirror DOM — so the component-scoped Tomboy content styles apply to
	// the clone. Terminal/loading windows fall back to the window body.
	$effect(() => {
		if (!active) return;
		const off = registerSnapshotSource(guid, () => ({
			title: note?.title?.trim() || '제목 없음',
			el: getEditor()?.view.dom.closest<HTMLElement>('.tomboy-editor') ?? bodyEl ?? null
		}));
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
		}, reloadToken);
		// Flush bus: a rename sweep elsewhere flushes this window BEFORE it
		// reads + rewrites this note, so an unsaved pending body edit in a
		// backlinked note lands in IDB first instead of being read stale,
		// rewritten over, and then dropped by the reload above. This is the
		// desktop multi-window case the mobile single-note flow can't hit.
		const offFlush = subscribeNoteFlush(g, () => flushSave());
		return () => {
			off();
			offFlush();
		};
	});

	// Load this note's background reactively: on guid change and on
	// noteChromeEpoch (a set/clear from the image right-click menu or this
	// window's own 해제). Token + cancelled guards mirror the workspace
	// wallpaper loader so a fast guid swap can't apply a stale image, and an
	// in-flight load resolving after unmount can't create an orphan ObjectURL.
	let noteBgToken = 0;
	$effect(() => {
		const g = guid;
		void desktopSession.noteChromeEpoch; // reactive dependency
		const token = ++noteBgToken;
		let cancelled = false;
		void (async () => {
			const [blob, mode] = await Promise.all([loadNoteBg(g), loadNoteBgMode(g)]);
			if (cancelled || token !== noteBgToken) return;
			const next = blob ? URL.createObjectURL(blob) : null;
			const prev = noteBgUrl;
			noteBgUrl = next;
			noteBgMode = mode;
			if (prev) URL.revokeObjectURL(prev);
		})();
		return () => {
			cancelled = true;
		};
	});

	// Load this note's saved window opacity on guid change. Set from the ⋯ menu
	// slider (local state drives the render immediately; persistence is async).
	$effect(() => {
		const g = guid;
		let cancelled = false;
		void loadNoteOpacity(g).then((v) => {
			if (!cancelled) noteOpacity = v;
		});
		return () => {
			cancelled = true;
		};
	});

	function handleOpacityChange(v: number) {
		noteOpacity = v;
		void setNoteOpacity(guid, v);
	}

	async function handleClearBackground() {
		await clearNoteBg(guid); // bumps noteChromeEpoch → bg effect reloads to null
		pushToast('노트 배경을 해제했습니다.');
	}

	// Apply a background chosen in NoteBackgroundPicker. URL sources are fetched
	// (and cached) via resolveImageBlob; cache sources are read straight from the
	// image cache. Either way we hand bytes to setNoteBg (which bumps
	// noteChromeEpoch → the bg effect reloads).
	async function handleApplyBackground(source: BgSource, mode: WallpaperMode) {
		bgPickerAnchor = null;
		try {
			const blob =
				source.kind === 'url' ? await resolveImageBlob(source.url) : await getBlob(source.url);
			if (!blob) throw new Error('image bytes unavailable');
			await setNoteBg(guid, blob, mode);
			pushToast('노트 배경으로 지정했습니다.');
		} catch {
			pushToast('노트 배경 지정 실패', { kind: 'error' });
		}
	}

	function handleEditorChange(doc: JSONContent) {
		isMusicNote = isMusicNoteDoc(doc);
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
		if (fresh.xmlContent === note.xmlContent) return; // no-op: nothing changed
		note = fresh;
		editorContent = getNoteEditorContent(fresh);
		isMusicNote = isMusicNoteDoc(editorContent as JSONContent);
		terminalSpec = parseTerminalNote(editorContent);
		if (!terminalSpec) terminalConnectMode = false;
		keysSpec = parseKeysNote(editorContent);
		if (!keysSpec) keysConnectMode = false;
		lastSavedDocFingerprint = null;
	}

	/**
	 * Called when another window's op has rewritten this note in IDB.
	 * We cancel any pending debounced save (its doc is stale — the
	 * fresh IDB content wins) and then reload as normal.
	 */
	async function externalReload(): Promise<void> {
		// Actively-typed editor must not be reloaded mid-keystroke.
		const ed = getEditor();
		if (ed?.isFocused && pendingDoc) return;
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

	// 전용 파일철 노트(탭::/묶음::)는 창 타이틀바를 숨기므로 드래그 이동 수단이
	// 없다 — 번들의 "활성 노트 타이틀"(탭 스트립의 활성 탭 / 묶음의 활성 바·편집
	// 헤더)에서 온 pointerdown 을 받아 일반 타이틀바와 동일하게 창을 이동시킨다.
	// 번들이 이벤트를 동기로 넘기므로 e.currentTarget(= 그 타이틀 엘리먼트)에
	// startPointerDrag 의 포인터 캡처가 걸린다.
	function handleBundleTitleDrag(e: PointerEvent) {
		if (e.button !== 0) return;
		onfocus(guid);
		const origX = x;
		const origY = y;
		// 임계(4px) 전까진 창을 안 움직인다 — 번들 타이틀/탭은 클릭(선택) 겸용이라
		// 작은 지터로 창이 흔들리면 안 된다. 임계 넘으면 그때부터 드래그 이동.
		let dragging = false;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				if (!dragging && Math.hypot(dx, dy) < 4) return;
				dragging = true;
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

	function openTitleDialog() {
		titleDialogOpen = true;
	}

	async function handleTitleSave(r: { title: string; typeId: string; notebook: string | null }) {
		if (!note) return;
		titleDialogOpen = false;
		// 본문에 미저장 디바운스 편집이 있으면 먼저 IDB 로 내린다 — renameNote 가
		// 옛 본문을 읽어 rewrite + reload 하며 그 편집을 잃지 않도록.
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
		// 본문은 renameNote 의 noteReload 로 갱신되고, 윈도우 타이틀(titleDisplay)은
		// 로컬 note 에서 파생되므로 재조회로 갱신.
		const updated = await getNote(note.guid);
		if (updated) note = updated;
		// 패널은 renameNote 의 noteReload 진행 중에 열려도 안전 — 스윕 확정 시 applySweep 가
		// 먼저 flushAll 하고, 대상 노트(이 창)는 스윕 candidates 에서 제외된다.
		newNoteFlow.openResult({
			heading: '제목 변경 완료',
			title: r.title,
			guid: note.guid,
			stages: [{ name: `제목 변경 · 백링크 ${backlinksUpdated}개 갱신`, ms, status: 'done' }]
		});
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
		const anchor = menuAnchor;
		menuAnchor = null;
		if (!note) return;

		if (kind === 'setBackground') {
			// Reuse the context-menu anchor so the picker pops where the menu was.
			bgPickerAnchor = anchor ?? { right: 8, bottom: 8 };
			return;
		}

		if (kind === 'editTitle') { openTitleDialog(); return; }

		if (kind === 'reflectTitle') {
			if (!note.title.trim()) return;
			newNoteFlow.openResult({
				heading: '전체 문서에 제목 반영',
				title: note.title,
				guid: note.guid,
				stages: []
			});
			void newNoteFlow.startSweepCount();
			return;
		}

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

		if (kind === 'history') {
			desktopSession.openHistory(note.guid);
			return;
		}

		if (kind === 'clearBackground') {
			await handleClearBackground();
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

	const titleDisplay = $derived(note?.title?.trim() || '제목 없음');
	const isFocused = $derived(desktopSession.focusedNoteGuid === guid);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={windowEl}
	class="note-window"
	class:hidden={!active}
	class:minimized
	data-has-bg={noteBgUrl ? 'true' : 'false'}
	style="left:{x}px; top:{y}px; width:{width}px; height:{height}px; z-index:{z};"
	style:background-color="rgba(255, 255, 255, {noteOpacity})"
	onpointerdowncapture={handleWindowPointerDown}
	onkeydown={handleKeyDown}
>
	<!-- 전용 파일철 뷰는 창 타이틀바 숨김(제목은 바에 노출, 닫기는 dchrome ✕).
	     드래그/핀은 사라지지만 리사이즈 핸들은 유지. raw 편집 모드선 다시 표시. -->
	{#if !(dedicatedKind && !showRawBundle)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="title-bar"
		class:focused={isFocused}
		onpointerdown={startDrag}
		onauxclick={handleTitleBarAuxClick}
		ondblclick={(e) => { if ((e.target as HTMLElement)?.closest('[data-no-drag]')) return; openTitleDialog(); }}
	>
		<NoteDragHandle title={note?.title ?? ''} draggable={true} />
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
		{#if onminimize}
			<button
				type="button"
				class="min-btn"
				onclick={() => onminimize?.(guid)}
				aria-label="최소화"
				title="최소화"
				data-no-drag
			>&#x1F5D5;</button>
		{/if}
		<button
			type="button"
			class="close-btn"
			onclick={handleClose}
			aria-label="창 닫기"
			data-no-drag
		>✕</button>
	</div>
	{/if}

	<div bind:this={bodyEl} class="body" class:terminal-edit={(!!terminalSpec && !showTerminal) || (!!keysSpec && !showKeys)}>
		{#if noteBgUrl && !loading}
			<!-- Per-note background image. A dedicated layer (not the window's
			     own background) so window opacity fades ONLY the body surface —
			     title bar, editor text, and bottom toolbar stay fully opaque.
			     Its own opacity fades the image in step with the translucent
			     window fill behind it. -->
			<NoteBgLayer url={noteBgUrl} mode={noteBgMode} opacity={noteOpacity} />
		{/if}
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
		{:else if dedicatedKind && dedicatedSpec && !showRawBundle}
			<!-- 전용 파일철 노트 — 본문 전체가 탭/묶음. 닫기(✕)=창 닫기(데스크탑),
			     Ctrl→편집(onraw)=일반 노트 보기. -->
			{#key guid}
				{#if dedicatedKind === 'bundle'}
					<NoteBundleCabinet
						spec={dedicatedSpec}
						view={null}
						hostGuid={guid}
						variant="dedicated"
						EditorComponent={TomboyEditor}
						oninternallink={handleInternalLink}
						onraw={() => (showRawBundle = true)}
						onclose={handleClose}
						onwindowdrag={handleBundleTitleDrag}
						onminimize={onminimize ? () => onminimize?.(guid) : undefined}
					/>
				{:else}
					<NoteBundleStack
						spec={dedicatedSpec}
						view={null}
						hostGuid={guid}
						variant="dedicated"
						EditorComponent={TomboyEditor}
						oninternallink={handleInternalLink}
						onraw={() => (showRawBundle = true)}
						onclose={handleClose}
						onwindowdrag={handleBundleTitleDrag}
						onminimize={onminimize ? () => onminimize?.(guid) : undefined}
					/>
				{/if}
			{/key}
		{:else if tallySpec && !showRawTally}
			<!-- 집계 전용 노트 — 본문 = 투표/퀴즈 뷰. Ctrl→편집(onraw)으로 raw 토글. -->
			{#key guid}
				<TallyNote spec={tallySpec} guid={guid} onraw={() => (showRawTally = true)} />
			{/key}
		{:else}
			{#if editorContent}
				<!-- 전용 노트 raw 뷰 — Ctrl 누르면 ↩ 묶음/집계 버튼으로 복귀. -->
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
				<!-- 재생 컨트롤은 창 본문 상단(제목 줄 위)에 고정 — 편집 영역을 가리지 않도록. -->
				{#if editorComponent?.getEditor() && isMusicNote}
					<MusicPlayerBar editor={editorComponent.getEditor()!} guid={guid} />
				{/if}
				<TomboyEditor
					bind:this={editorComponent}
					content={editorContent}
					onchange={handleEditorChange}
					onblur={() => { void flushSave(); }}
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
					keepCursorVisible={true}
					cursorVisibilityMode="container"
					onimageinserted={handleImageInserted}
					onsendremarkable={() => (sendRemarkableOpen = true)}
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

	{#if !loading && editorContent && isFocused && !showTerminal && !showKeys && !(dedicatedKind && !showRawBundle) && !(tallySpec && !showRawTally)}
		<!-- 전용 파일철/집계 뷰엔 호스트 에디터가 없어 툴바가 무의미 — 숨김. raw 편집 모드에선 표시. -->
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
		opacity={noteOpacity}
		hasBackground={!!noteBgUrl}
		anchor={menuAnchor}
		onaction={handleAction}
		onopacity={handleOpacityChange}
		onclose={() => (menuAnchor = null)}
		onbacklinks={() => { menuAnchor = null; backlinkBundleOpen = true; }}
	/>
{/if}

{#if bgPickerAnchor && note}
	<NoteBackgroundPicker
		anchor={bgPickerAnchor}
		onapply={handleApplyBackground}
		onclose={() => (bgPickerAnchor = null)}
	/>
{/if}

{#if backlinkBundleOpen && note}
	<BacklinkBundleOverlay
		targetTitle={note.title}
		targetGuid={note.guid}
		windowed={true}
		onclose={() => (backlinkBundleOpen = false)}
		oninternallink={(t) => { backlinkBundleOpen = false; void handleInternalLink(t); }}
	/>
{/if}

{#if xmlViewerOpen && note}
	<NoteXmlViewer
		title={note.title}
		xml={note.xmlContent}
		onclose={() => (xmlViewerOpen = false)}
	/>
{/if}

{#if sendRemarkableOpen && note && active}
	<SendToRemarkableModal
		rootGuid={note.guid}
		onclose={() => (sendRemarkableOpen = false)}
	/>
{/if}

{#if titleDialogOpen && note}
	<NoteTitleDialog
		mode="edit"
		notebooks={notebookNames}
		initialTitle={note.title}
		initialNotebook={currentNotebook}
		onsubmit={(r) => handleTitleSave(r)}
		oncancel={() => (titleDialogOpen = false)}
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
	   completely hidden from layout, hit-testing, and focus. Minimized
	   windows use the same mechanism: hidden but mounted, so the editor /
	   terminal / spread-snapshot stay live and F4 still sees the note. */
	.note-window.hidden,
	.note-window.minimized {
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

	/* Active (topmost) note gets the SidePanel's green accent so the user can
	   tell at a glance which note has focus. */
	.title-bar.focused {
		background: #2d5a3d;
	}

	.title-bar:active {
		cursor: grabbing;
	}

	.title-text {
		flex: 1;
		/* 제목 느낌이 나도록 키운다 — 윈도우 헤더지만 노트 제목이 주인공. */
		font-size: 1.1rem;
		font-weight: 600;
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

	.min-btn {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: #ccc;
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
		border-radius: 3px;
		opacity: 0.6;
	}

	.min-btn:hover {
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
		/* 음악 컨트롤 패널(absolute)의 offsetParent 기준. */
		position: relative;
	}

	/* Per-note background image layer lives in the shared NoteBgLayer component
	   (also used by the note bundle stack); its 5 display modes are defined
	   there, not duplicated here. */

	.body :global(.tomboy-editor-shell) {
		flex: 1;
		min-height: 0;
	}

	/* Readability outline: when a background is set, give the (dark) editor text a
	   crisp white border so it stays legible over busy/dark imagery. Uses 1px
	   *offset* shadows in 8 directions with ZERO blur radius — a blur-based glow
	   (0 0 Npx) reads hazy/fuzzy over textured backgrounds, an offset stack reads
	   as a sharp outline. Applied on .tiptap so it inherits to all body text; the
	   dark title bar is a separate element and unaffected. Removed automatically
	   when the background clears (data-has-bg flips to false). */
	.note-window[data-has-bg='true'] .body :global(.tomboy-editor .tiptap) {
		text-shadow:
			1px 0 0 rgba(255, 255, 255, 0.55),
			-1px 0 0 rgba(255, 255, 255, 0.55),
			0 1px 0 rgba(255, 255, 255, 0.55),
			0 -1px 0 rgba(255, 255, 255, 0.55);
	}

	/* Let the note background show THROUGH an embedded note bundle. A bundle
	   (inline 탭/묶음 in the editor, or a dedicated 탭::/묶음:: note's cabinet)
	   renders inside this window's .body and paints its own opaque card fill
	   (.bundle-stack) + content fill (.bundle-body) ON TOP of the bg layer,
	   hiding it. Clearing just those two surfaces lets the layer behind paint
	   through; the tab strips / title bars keep their own chrome colour so they
	   stay legible. Gated on data-has-bg so a bundle without a background keeps
	   its normal opaque look. */
	.note-window[data-has-bg='true'] :global(.bundle-stack),
	.note-window[data-has-bg='true'] :global(.bundle-body),
	/* 묶음(Cabinet) 훑어보기 모드의 펼친 본문은 회색(#ecebe6)을 더 높은
	   specificity 로 덮으므로 명시적으로 같이 투명화해 배경이 비치게 한다.
	   (탭/Stack 에는 이 규칙이 없어 위 두 줄로 충분했다.) */
	.note-window[data-has-bg='true'] :global(.bundle-stack.browse .bundle-body.open) {
		background: transparent;
	}

	/* 전용 노트 raw 뷰에서 Ctrl 누른 동안만 뜨는 번들 복귀 버튼 — 좌상단. */
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
