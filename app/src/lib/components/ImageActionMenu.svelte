<script lang="ts">
	import { imageActionMenu } from '$lib/stores/imageActionMenu.svelte.js';
	import { copyImageToClipboard, copyImageUrlToClipboard, resolveImageBlob } from '$lib/editor/imageActions/copyImage.js';
	import { portal } from '$lib/utils/portal.js';
	import { page } from '$app/state';
	import { desktopSession, type WallpaperMode } from '$lib/desktop/session.svelte.js';
	import { pushToast } from '$lib/stores/toast.js';

	// Display modes offered under 「바탕화면으로 지정」 — order matches the common
	// desktop-OS wallpaper picker. Selecting one sets the image AND its fill mode
	// for the current workspace in one shot.
	const WALLPAPER_MODES: { mode: WallpaperMode; label: string }[] = [
		{ mode: 'cover', label: '채우기' },
		{ mode: 'contain', label: '맞춤' },
		{ mode: 'fill', label: '확대' },
		{ mode: 'center', label: '가운데' },
		{ mode: 'tile', label: '바둑판식' }
	];

	const menu = $derived(imageActionMenu.state);

	let el = $state<HTMLDivElement | null>(null);
	let pos = $state<{ left: number; top: number } | null>(null);

	// Clamp the menu inside the viewport once it has a measurable size — keeps
	// it on screen when long-pressed near a screen edge (common on mobile).
	$effect(() => {
		const m = menu;
		if (!m || !el) {
			pos = null;
			return;
		}
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const left = Math.max(4, Math.min(m.x, vw - rect.width - 4));
		const top = Math.max(4, Math.min(m.y, vh - rect.height - 4));
		pos = { left, top };
	});

	function close() {
		submenuOpen = false;
		imageActionMenu.close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	async function doCopyImage() {
		const href = menu?.href;
		close();
		if (href) await copyImageToClipboard(href);
	}

	async function doCopyUrl() {
		const href = menu?.href;
		close();
		if (href) await copyImageUrlToClipboard(href);
	}

	const isDesktop = $derived(page.url.pathname.startsWith('/desktop'));

	let submenuOpen = $state(false);

	// Flip the flyout to the left of its parent when the menu sits too close to
	// the right edge to fit a right-side submenu.
	const SUBMENU_W = 150;
	const flipLeft = $derived.by(() => {
		if (!pos || typeof window === 'undefined') return false;
		return pos.left + 168 + SUBMENU_W > window.innerWidth;
	});

	async function doSetWallpaper(mode: WallpaperMode) {
		const href = menu?.href;
		close();
		if (!href) return;
		try {
			const blob = await resolveImageBlob(href);
			if (!blob) throw new Error('image bytes unavailable');
			await desktopSession.setWallpaperForCurrent(blob, mode);
			pushToast('배경화면으로 지정했습니다');
		} catch {
			pushToast('배경화면 지정 실패', { kind: 'error' });
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if menu}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div use:portal class="img-ctx-backdrop" onpointerdown={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		bind:this={el}
		class="img-ctx-menu"
		role="menu"
		style:left="{pos ? pos.left : menu.x}px"
		style:top="{pos ? pos.top : menu.y}px"
		style:visibility={pos ? 'visible' : 'hidden'}
	>
		<button class="item" onclick={doCopyImage}>이미지 복사</button>
		<button class="item" onclick={doCopyUrl}>이미지 주소 복사</button>
		{#if isDesktop}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="submenu-wrap"
				onmouseenter={() => (submenuOpen = true)}
				onmouseleave={() => (submenuOpen = false)}
			>
				<button
					class="item submenu-parent"
					aria-haspopup="menu"
					aria-expanded={submenuOpen}
					onclick={() => (submenuOpen = !submenuOpen)}
				>
					<span>바탕화면으로 지정</span>
					<span class="chev" aria-hidden="true">▸</span>
				</button>
				{#if submenuOpen}
					<div class="submenu" class:flip-left={flipLeft} role="menu">
						{#each WALLPAPER_MODES as m (m.mode)}
							<button class="item" role="menuitem" onclick={() => doSetWallpaper(m.mode)}>
								{m.label}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.img-ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-popover);
	}
	.img-ctx-menu {
		position: fixed;
		z-index: var(--z-popover);
		background: #fff;
		color: #111;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		min-width: 160px;
		padding: 4px;
		font-size: 0.9rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: none;
		border: none;
		text-align: left;
		width: 100%;
		cursor: pointer;
		color: inherit;
		border-radius: 4px;
		font-size: inherit;
	}
	.item:hover {
		background: #f0f3f7;
	}
	.submenu-wrap {
		position: relative;
	}
	.submenu-parent {
		justify-content: space-between;
	}
	.submenu-parent[aria-expanded='true'] {
		background: #f0f3f7;
	}
	.chev {
		opacity: 0.6;
		font-size: 0.8em;
	}
	.submenu {
		position: absolute;
		top: -4px;
		left: 100%;
		margin-left: 2px;
		min-width: 110px;
		background: #fff;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		padding: 4px;
	}
	.submenu.flip-left {
		left: auto;
		right: 100%;
		margin-left: 0;
		margin-right: 2px;
	}
</style>
