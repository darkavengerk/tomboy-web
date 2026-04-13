<script lang="ts">
	import { onMount } from 'svelte';
	import NoteWindow from './NoteWindow.svelte';
	import SettingsWindow from './SettingsWindow.svelte';
	import SidePanel from './SidePanel.svelte';
	import { desktopSession } from './session.svelte.js';

	let ready = $state(false);

	onMount(() => {
		(async () => {
			await desktopSession.load();
			ready = true;
		})();
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
</script>

<div class="desktop-root">
	<div class="canvas" aria-label="노트 작업 공간">
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

	<SidePanel openGuids={openGuidSet} onopen={handleOpen} onopensettings={handleOpenSettings} />
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
</style>
