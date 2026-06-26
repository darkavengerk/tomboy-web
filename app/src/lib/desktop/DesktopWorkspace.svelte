<script lang="ts">
	import { onMount } from 'svelte';
	import NoteWindow from './NoteWindow.svelte';
	import SettingsWindow from './SettingsWindow.svelte';
	import AdminWindow from './AdminWindow.svelte';
	import HistoryWindow from './HistoryWindow.svelte';
	import SidePanel from './SidePanel.svelte';
	import {
		desktopSession,
		loadWallpaper,
		loadWallpaperMode,
		setWallpaper,
		DESKTOP_PINNED_Z,
		SLIPNOTE_WORKSPACE_INDEX,
		type WallpaperMode
	} from './session.svelte.js';
	import { sidePanelLayout } from './sidePanelLayout.svelte.js';
	import { activeNotebooks } from './activeNotebooks.svelte.js';
	import { installModKeyListeners } from './modKeys.svelte.js';
	import { extractNoteGuidFromText, openNoteByGuid } from './openByClipboard.js';
	import SpreadOverlay from './spreadView/SpreadOverlay.svelte';
	import DrawerOverlay from './DrawerOverlay.svelte';
	import { spreadView } from './spreadView/spreadView.svelte.js';
	import { createNote } from '$lib/core/noteManager.js';
	import {
		parseSlipNeighbors,
		type SlipNoteArrowsStorage
	} from '$lib/editor/extensions/SlipNoteArrows.js';
	import type { DateArrowsStorage } from '$lib/editor/extensions/DateArrows.js';

	let ready = $state(false);
	let wallpaperUrl = $state<string | null>(null);
	let wallpaperMode = $state<WallpaperMode>('contain');

	onMount(() => {
		(async () => {
			await desktopSession.load();
			ready = true;
		})();

		const handler = (e: KeyboardEvent) => onKey(e);
		// `capture: true` so this handler runs BEFORE any inner contenteditable
		// or TipTap plugin sees the key. Critical for Ctrl+. on Chrome
		// (Windows/Linux), which the OS / browser otherwise turns into an
		// emoji-picker invocation before our preventDefault has a chance.
		window.addEventListener('keydown', handler, { capture: true });
		const pasteHandler = (e: ClipboardEvent) => onPaste(e);
		window.addEventListener('paste', pasteHandler);
		const uninstallModKeys = installModKeyListeners();

		return () => {
			window.removeEventListener('keydown', handler, { capture: true });
			window.removeEventListener('paste', pasteHandler);
			uninstallModKeys();
			if (wallpaperUrl) {
				URL.revokeObjectURL(wallpaperUrl);
				wallpaperUrl = null;
			}
		};
	});

	// Reload the canvas wallpaper for the active workspace. Re-runs on
	// workspace switch (currentWorkspace) and on any wallpaper set/clear
	// (wallpaperEpoch). The token guards against a fast switch resolving an
	// older load after a newer one; the cleanup `cancelled` flag also aborts
	// an in-flight load on unmount, so a load that resolves after the component
	// is gone can't create an orphan ObjectURL the unmount revoke already missed.
	let wallpaperLoadToken = 0;
	$effect(() => {
		const ws = desktopSession.currentWorkspace;
		void desktopSession.wallpaperEpoch; // reactive dependency
		const token = ++wallpaperLoadToken;
		let cancelled = false;
		void (async () => {
			const [blob, mode] = await Promise.all([loadWallpaper(ws), loadWallpaperMode(ws)]);
			if (cancelled || token !== wallpaperLoadToken) return; // superseded or unmounted
			const next = blob ? URL.createObjectURL(blob) : null;
			const prev = wallpaperUrl;
			wallpaperUrl = next;
			wallpaperMode = mode;
			if (prev) URL.revokeObjectURL(prev);
		})();
		return () => {
			cancelled = true;
		};
	});

	const openGuidSet = $derived(new Set(desktopSession.windows.map((w) => w.guid)));

	function handleOpen(guid: string) {
		desktopSession.openWindow(guid);
	}

	function handleFocus(guid: string) {
		desktopSession.focusWindow(guid);
	}

	function handleClose(guid: string) {
		void desktopSession.closeWindow(guid);
	}

	function handleMinimize(guid: string) {
		desktopSession.minimizeWindow(guid);
	}

	function handleRestore(guid: string) {
		desktopSession.restoreWindow(guid);
	}

	function handleStash(guid: string) {
		void desktopSession.stashToActiveDrawer(guid);
	}

	// Drag-end for a canvas window: hand the viewport pointer + window top-left to
	// the session, which hit-tests the open drawer and moves the note in (or just
	// repositions it on the canvas). Returns the promise so NoteWindow can hold
	// the lift until a cross-surface move settles.
	function handleCanvasDragEnd(
		guid: string,
		pointer: { x: number; y: number },
		winTopLeft: { x: number; y: number }
	) {
		return desktopSession.dropDraggedWindow(
			{ kind: 'workspace', index: desktopSession.currentWorkspace },
			guid,
			winTopLeft,
			pointer,
			sidePanelLayout.railWidth
		);
	}

	// 'up' when drawer 0 (F2, top) open, 'right' when drawer 1 (F3) open, else null.
	const stashArrowDir: 'up' | 'right' | null = $derived(
		desktopSession.activeDrawer === 0
			? 'up'
			: desktopSession.activeDrawer === 1
				? 'right'
				: null
	);

	function handleMove(guid: string, x: number, y: number) {
		desktopSession.moveWindow(guid, x, y);
	}

	function handleResize(guid: string, width: number, height: number) {
		desktopSession.resizeWindow(guid, width, height);
	}

	function handleOpenLink(title: string) {
		void desktopSession.openByTitle(title);
	}

	function handleOpenSettings() {
		desktopSession.openSettings();
	}

	function handleOpenAdmin() {
		desktopSession.openAdmin();
	}

	function handleSwitchWorkspace(index: number) {
		void desktopSession.switchWorkspace(index);
	}

	const hasNoteWindows = $derived(desktopSession.windows.some((w) => w.kind === 'note'));

	// Current-workspace minimized notes (most-recently-minimized first) for the
	// SidePanel 최소화됨 list. SidePanel resolves titles from its own corpus.
	const minimizedGuids = $derived(desktopSession.minimizedWindows.map((w) => w.guid));

	function handleSpread() {
		if (hasNoteWindows) spreadView.open();
	}

	// --- Keyboard shortcuts ---------------------------------------------

	async function handleCtrlL(title: string) {
		const note = await createNote(title);
		const width = 560;
		const height = 520;
		// x/y are canvas-local: (0, 0) is the top-left of the note area,
		// which already sits to the right of the SidePanel rail.
		const vw = window.innerWidth - sidePanelLayout.railWidth;
		const vh = window.innerHeight;
		const x = Math.max(0, Math.round((vw - width) / 2));
		const y = Math.max(0, Math.round((vh - height) / 2 - 60));
		desktopSession.openWindowAt(note.guid, { x, y, width, height });
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		return target.isContentEditable;
	}

	// Native paste handler — fires synchronously for Ctrl/Cmd+V with the
	// clipboard text already attached, so we can read it without triggering
	// the async Clipboard API permission prompt. We only act when no editor
	// or input owns focus (otherwise the normal paste must run unimpeded).
	function onPaste(e: ClipboardEvent) {
		if (desktopSession.getFocusedEditor()) return;
		if (isEditableTarget(e.target)) return;
		const text = e.clipboardData?.getData('text/plain') ?? '';
		const guid = extractNoteGuidFromText(text);
		if (!guid) return;
		e.preventDefault();
		void openNoteByGuid(guid);
	}

	function onKey(e: KeyboardEvent) {
		// F4 — toggle 펼쳐보기 (spread view). No modifiers. preventDefault so
		// no browser/OS default fires. Opens only when at least one note window
		// exists; always closable.
		if (
			e.key === 'F4' &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			if (spreadView.isOpen || hasNoteWindows) spreadView.toggle();
			return;
		}
		// F2 / F3 — toggle the left / right drawer (ddterm-style). No modifiers.
		if (
			(e.key === 'F2' || e.key === 'F3') &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			desktopSession.toggleDrawer(e.key === 'F2' ? 0 : 1);
			return;
		}
		// Ctrl+L (or Cmd+L on macOS) without other modifiers — new note from selection.
		if (
			e.key.toLowerCase() === 'l' &&
			(e.ctrlKey || e.metaKey) &&
			!e.altKey &&
			!e.shiftKey
		) {
			const focused = desktopSession.getFocusedEditor();
			if (!focused) return;
			const { editor } = focused;
			const { from, to } = editor.state.selection;
			if (from === to) return;
			const text = editor.state.doc.textBetween(from, to, '\n').trim();
			if (!text) return;
			e.preventDefault();
			void handleCtrlL(text);
			return;
		}
		// Ctrl/Cmd+` — reopen the most recently closed note (undo an accidental
		// Esc close). Alt+Esc was the original binding but Linux/GNOME window
		// managers grab Alt+Esc at the OS level (direct window switch) before
		// the page ever sees it, so it can't be preventDefault'd. Ctrl+` has no
		// OS / browser / TipTap binding, so it reaches us cleanly.
		if (e.key === '`' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
			// 탭 파일철(NoteBundleStack) 안에 포커스가 있으면 Ctrl+` 는 그 안의
			// '직전 탭(MRU)' 전용 — 여기선 양보(reopenLastClosed 안 함, preventDefault
			// 도 안 해 이벤트가 그대로 버블해 번들 자체 핸들러가 처리). 탭 밖(묶음
			// 서류함·일반 노트·캔버스)에선 기존대로 마지막 닫은 노트 다시 열기.
			if ((document.activeElement as HTMLElement | null)?.closest?.('[data-tab-cabinet]')) {
				return;
			}
			e.preventDefault();
			void desktopSession.reopenLastClosed();
			return;
		}
		// Ctrl/Cmd+ArrowUp / ArrowDown — scroll the active (topmost) note in
		// that direction. Requires no Alt so it can't collide with the
		// Ctrl+Alt+Arrow workspace switch below. stopPropagation keeps the
		// combo away from TipTap's caret-movement handlers.
		if (
			(e.ctrlKey || e.metaKey) &&
			!e.altKey &&
			!e.shiftKey &&
			(e.key === 'ArrowUp' || e.key === 'ArrowDown')
		) {
			const guid = desktopSession.focusedNoteGuid;
			if (!guid) return;
			const editor = desktopSession.getEditorForGuid(guid);
			const el = editor?.view.dom.parentElement as HTMLElement | null | undefined;
			if (!el) return;
			e.preventDefault();
			e.stopPropagation();
			const step = Math.max(80, Math.round(el.clientHeight * 0.4));
			el.scrollBy({ top: e.key === 'ArrowDown' ? step : -step, behavior: 'smooth' });
			return;
		}
		// Ctrl+Alt+Arrow — switch workspace (no wrap-around).
		if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
			const map: Record<string, 'left' | 'right' | 'up' | 'down'> = {
				ArrowLeft: 'left',
				ArrowRight: 'right',
				ArrowUp: 'up',
				ArrowDown: 'down'
			};
			const dir = map[e.key];
			if (!dir) return;
			e.preventDefault();
			void desktopSession.switchWorkspaceDir(dir);
			return;
		}
		// Ctrl/Cmd+[  /  Ctrl/Cmd+]  — step through slip-note or date-note
		// chain in "replace" mode: close the focused note window and open
		// the prev/next note in its place. Mirrors the Ctrl-click behavior
		// on the arrow buttons. Always preventDefault to suppress any
		// browser/OS default for the combo even when no neighbour is
		// available, so the user gets consistent behavior.
		if (
			(e.key === '[' || e.key === ']') &&
			(e.ctrlKey || e.metaKey) &&
			!e.altKey &&
			!e.shiftKey
		) {
			// Suppress browser/OS defaults and stop the event from reaching
			// TipTap's contenteditable handlers. `stopImmediatePropagation`
			// also blocks any other listeners on the same element.
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			const direction: 'prev' | 'next' = e.key === '[' ? 'prev' : 'next';
			const focusedEditor = desktopSession.getFocusedEditor();
			const guid = focusedEditor?.guid ?? desktopSession.focusedNoteGuid;
			if (!guid) return;
			const editor = focusedEditor?.editor ?? desktopSession.getEditorForGuid(guid);
			if (!editor) return;
			const storages = editor.storage as unknown as Record<string, unknown>;
			let target: string | null = null;
			const slip = storages.slipNoteArrows as SlipNoteArrowsStorage | undefined;
			if (slip?.enabled) {
				const neighbors = parseSlipNeighbors(editor.state.doc);
				target = direction === 'prev' ? neighbors.prev : neighbors.next;
			} else {
				const dateArr = storages.dateArrows as DateArrowsStorage | undefined;
				if (dateArr?.enabled) {
					target = direction === 'prev' ? dateArr.prevTitle : dateArr.nextTitle;
				}
			}
			if (!target) return;
			void desktopSession.openReplacing(guid, target);
		}
	}

	// --- Wallpaper drop -------------------------------------------------

	function onCanvasDragOver(e: DragEvent) {
		if (!e.dataTransfer) return;
		if (Array.from(e.dataTransfer.types).includes('Files')) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
		}
	}

	async function onCanvasDrop(e: DragEvent) {
		const file = e.dataTransfer?.files?.[0];
		if (!file || !file.type.startsWith('image/')) return;
		e.preventDefault();
		try {
			await setWallpaper(file, desktopSession.currentWorkspace);
		} catch {
			return;
		}
	}

	// 빈 캔버스 배경 클릭 → SidePanel .main 잠금 열기/닫기 토글. 노트 창을
	// 클릭하면 e.target이 창 내부라 currentTarget(.canvas)과 달라 무시된다.
	// 벽지 div는 pointer-events:none이라 그 위 클릭도 target=.canvas로 도달.
	//
	// 드래그-끝 오토글 방지: pointerdown이 빈 캔버스에서 시작했고(창에서
	// 드래그해 캔버스에서 놓으면 click이 공통조상=.canvas로 떠서 target===
	// currentTarget이 됨), 이동량이 작을 때만 토글한다.
	let canvasDownAt: { x: number; y: number } | null = null;
	// pointerdown 시점에 노트 에디터가 캐럿(DOM 포커스)을 쥐고 있었는지 — 즉 빨간색
	// 타이틀의 활성 노트가 있었는지. 캔버스 클릭이 포커스를 떼어내는 게 기본 동작이라
	// (blur 는 클릭의 default action = 리스너 이후) click 시점엔 이미 늦으므로 down 에서 캡처.
	let noteFocusedAtDown = false;
	function aNoteHasCaret(): boolean {
		const ae = document.activeElement as HTMLElement | null;
		if (!ae || !ae.closest('.note-window')) return false;
		return ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA';
	}
	function onCanvasPointerDown(e: PointerEvent) {
		const onBare = e.target === e.currentTarget;
		canvasDownAt = onBare ? { x: e.clientX, y: e.clientY } : null;
		noteFocusedAtDown = onBare && aNoteHasCaret();
	}
	function onCanvasClick(e: MouseEvent) {
		if (e.target !== e.currentTarget) return;
		const down = canvasDownAt;
		const wasEditing = noteFocusedAtDown;
		canvasDownAt = null;
		noteFocusedAtDown = false;
		if (!down) return; // 드래그가 캔버스 밖(창 등)에서 시작
		if (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4) return; // 드래그였음
		// 활성(캐럿/빨간 타이틀) 노트가 있었으면 이 배경 클릭은 노트 포커스 해제 의도 —
		// 패널을 열어봐야 도움이 안 되니 토글하지 않는다(현재 상태 유지).
		if (wasEditing) return;
		// 슬립노트 작업공간은 .main이 항상 열림(always-open)이라 잠금 토글이
		// 화면엔 안 보이면서 lockedOpen만 켜져 다른 작업공간으로 새어나간다. 무시.
		if (desktopSession.currentWorkspace === SLIPNOTE_WORKSPACE_INDEX) return;
		activeNotebooks.toggleLockedOpen();
	}
</script>

<div class="desktop-root" style="--rail-width: {sidePanelLayout.railWidth}px;">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="canvas"
		aria-label="노트 작업 공간"
		ondragover={onCanvasDragOver}
		ondrop={onCanvasDrop}
		onpointerdown={onCanvasPointerDown}
		onclick={onCanvasClick}
	>
		{#if wallpaperUrl}
			<div
				class="wallpaper"
				data-mode={wallpaperMode}
				style:background-image="url({wallpaperUrl})"
				aria-hidden="true"
			></div>
		{/if}
		{#if ready}
			<!-- Render every workspace's windows at once and hide non-active
			     ones via CSS. Switching workspaces becomes a pure visibility
			     toggle — TipTap editors, terminal WS connections, and all
			     in-memory state survive the switch. Firebase attach and the
			     global editor registry are gated on `active` so only the
			     visible workspace is "live". -->
			{#each desktopSession.allWorkspaceWindows as item (item.workspaceIndex + ':' + item.window.guid)}
				{@const win = item.window}
				{@const visible = item.workspaceIndex === desktopSession.currentWorkspace}
				{@const live = visible && desktopSession.activeDrawer === null}
				{#if win.kind === 'settings'}
					<SettingsWindow
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
						pinned={win.pinned}
						active={visible}
						onfocus={handleFocus}
						onclose={handleClose}
						onmove={handleMove}
						onresize={handleResize}
					/>
				{:else if win.kind === 'admin'}
					<AdminWindow
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
						pinned={win.pinned}
						active={visible}
						onfocus={handleFocus}
						onclose={handleClose}
						onmove={handleMove}
						onresize={handleResize}
					/>
				{:else if win.kind === 'history'}
					<HistoryWindow
						guid={win.guid}
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
						pinned={win.pinned}
						active={visible}
						onfocus={handleFocus}
						onclose={handleClose}
						onmove={handleMove}
						onresize={handleResize}
					/>
				{:else}
					<NoteWindow
						guid={win.guid}
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={(win.pinned ? DESKTOP_PINNED_Z : 0) + win.z}
						pinned={win.pinned}
						active={live}
						hidden={!visible}
						minimized={win.minimized}
						onfocus={handleFocus}
						onclose={handleClose}
						onminimize={handleMinimize}
						onmove={handleMove}
						onresize={handleResize}
						onopenlink={handleOpenLink}
						stashArrow={visible ? stashArrowDir : null}
						onstash={handleStash}
						ondragend={handleCanvasDragEnd}
					/>
				{/if}
			{/each}
		{/if}
	</div>

	<SidePanel
		openGuids={openGuidSet}
		currentWorkspace={desktopSession.currentWorkspace}
		workspaceSummaries={desktopSession.workspaceSummaries}
		{minimizedGuids}
		onopen={handleOpen}
		onrestore={handleRestore}
		onopensettings={handleOpenSettings}
		onopenadmin={handleOpenAdmin}
		onswitchworkspace={handleSwitchWorkspace}
		onspread={handleSpread}
		spreadDisabled={!hasNoteWindows}
	/>
	{#if spreadView.isOpen}
		<SpreadOverlay />
	{/if}
	<DrawerOverlay index={0} side="top" />
	<DrawerOverlay index={1} side="right" />
	<!-- Drag-lift host: the note currently being dragged is re-parented here (via
	     the dragLift action) so it floats above the drawer panels and isn't
	     clipped by .canvas/.drawer. Empty + pointer-events:none until then, so it
	     never intercepts clicks; the lifted window re-enables its own. -->
	<div class="drag-layer"></div>
</div>

<style>
	.desktop-root {
		position: fixed;
		inset: 0;
		background: #000;
		color: #eee;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	.canvas {
		position: fixed;
		/* Reserve the SidePanel rail (user-resizable, see sidePanelLayout)
		   on the left. Notes use canvas-local coordinates: their stored
		   (0, 0) corresponds to the canvas's top-left, so moving or
		   resizing the rail is a pure CSS change — no note coordinates need
		   to migrate. */
		left: var(--rail-width, 80px);
		right: 0;
		top: 0;
		bottom: 0;
		background: #000;
		overflow: hidden;
	}

	/* Drag-lift host — viewport-aligned (matches absolute coords to viewport),
	   above the drawer panels (--z-drag), never clips. Inert until a window is
	   lifted into it; the lifted .note-window sets its own pointer-events. */
	.drag-layer {
		position: fixed;
		inset: 0;
		overflow: visible;
		pointer-events: none;
		z-index: var(--z-drag);
	}

	.wallpaper {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		user-select: none;
		z-index: 0;
		/* Base = 맞춤(contain). data-mode overrides below; an unknown mode
		   keeps this default so old wallpapers render unchanged. */
		background-repeat: no-repeat;
		background-position: center;
		background-size: contain;
	}
	.wallpaper[data-mode='cover'] {
		background-size: cover;
	}
	.wallpaper[data-mode='contain'] {
		background-size: contain;
	}
	.wallpaper[data-mode='fill'] {
		background-size: 100% 100%;
	}
	.wallpaper[data-mode='center'] {
		background-size: auto;
	}
	.wallpaper[data-mode='tile'] {
		background-position: top left;
		background-repeat: repeat;
		background-size: auto;
	}
</style>
