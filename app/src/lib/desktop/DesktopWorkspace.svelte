<script lang="ts">
	import { onMount } from 'svelte';
	import NoteWindow from './NoteWindow.svelte';
	import SettingsWindow from './SettingsWindow.svelte';
	import SidePanel from './SidePanel.svelte';
	import {
		desktopSession,
		loadWallpaper,
		setWallpaper
	} from './session.svelte.js';
	import { createNote } from '$lib/core/noteManager.js';

	let ready = $state(false);
	let wallpaperUrl = $state<string | null>(null);

	onMount(() => {
		(async () => {
			await desktopSession.load();
			ready = true;
			const blob = await loadWallpaper();
			if (blob) wallpaperUrl = URL.createObjectURL(blob);
		})();

		const handler = (e: KeyboardEvent) => onKey(e);
		window.addEventListener('keydown', handler);

		return () => {
			window.removeEventListener('keydown', handler);
			if (wallpaperUrl) {
				URL.revokeObjectURL(wallpaperUrl);
				wallpaperUrl = null;
			}
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

	function handleSwitchWorkspace(index: number) {
		void desktopSession.switchWorkspace(index);
	}

	// --- Keyboard shortcuts ---------------------------------------------

	async function handleCtrlL(title: string) {
		const note = await createNote(title);
		const width = 560;
		const height = 520;
		const vw = window.innerWidth - 300; // canvas width (panel is 300px)
		const vh = window.innerHeight;
		const x = Math.max(0, Math.round((vw - width) / 2));
		const y = Math.max(0, Math.round((vh - height) / 2 - 60)); // slightly above center
		desktopSession.openWindowAt(note.guid, { x, y, width, height });
	}

	function onKey(e: KeyboardEvent) {
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
			await setWallpaper(file);
		} catch {
			return;
		}
		const prev = wallpaperUrl;
		wallpaperUrl = URL.createObjectURL(file);
		if (prev) URL.revokeObjectURL(prev);
	}
</script>

<div class="desktop-root">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="canvas"
		aria-label="노트 작업 공간"
		ondragover={onCanvasDragOver}
		ondrop={onCanvasDrop}
	>
		{#if wallpaperUrl}
			<img class="wallpaper" src={wallpaperUrl} alt="" aria-hidden="true" />
		{/if}
		{#if ready}
			{#each desktopSession.windows as win (win.guid)}
				{#if win.kind === 'settings'}
					<SettingsWindow
						x={win.x}
						y={win.y}
						width={win.width}
						height={win.height}
						z={win.z}
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
						z={win.z}
						onfocus={handleFocus}
						onclose={handleClose}
						onmove={handleMove}
						onresize={handleResize}
						onopenlink={handleOpenLink}
					/>
				{/if}
			{/each}
		{/if}
	</div>

	<SidePanel
		openGuids={openGuidSet}
		currentWorkspace={desktopSession.currentWorkspace}
		workspaceSummaries={desktopSession.workspaceSummaries}
		onopen={handleOpen}
		onopensettings={handleOpenSettings}
		onswitchworkspace={handleSwitchWorkspace}
	/>
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
		left: 0;
		top: 0;
		bottom: 0;
		right: 300px;
		background: #000;
		overflow: hidden;
	}

	.wallpaper {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		max-width: 100%;
		max-height: 100%;
		pointer-events: none;
		user-select: none;
		z-index: 0;
	}
</style>
