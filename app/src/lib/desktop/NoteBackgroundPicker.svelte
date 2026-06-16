<script lang="ts" module>
	/** Where the chosen background bytes come from. The host resolves these to a
	 * blob (URL → fetch+cache, cache → direct read) before calling setNoteBg, so
	 * this component stays free of IDB/toast concerns and is easy to test. */
	export type BgSource = { kind: 'url'; url: string } | { kind: 'cache'; url: string };
</script>

<script lang="ts">
	import { portal } from '$lib/utils/portal.js';
	import { listCached, getBlob, type CachedImageInfo } from '$lib/imageCache/imageCache.js';
	import type { WallpaperMode } from '$lib/desktop/session.svelte.js';

	interface Props {
		/** Anchor (mirrors NoteContextMenu) — positions the popover from the
		 * right/bottom edges so it lines up with the ⋯ menu button. */
		anchor: { right: number; bottom: number };
		/** Emit the chosen source + display mode. Host does the actual apply. */
		onapply: (source: BgSource, mode: WallpaperMode) => void;
		onclose: () => void;
	}

	let { anchor, onapply, onclose }: Props = $props();

	// Display modes — same five as the workspace wallpaper / image-menu picker.
	// Default is `cover` (a deliberately-chosen background usually wants full
	// coverage), unlike the image right-click menu whose default is contain.
	const MODES: { mode: WallpaperMode; label: string }[] = [
		{ mode: 'cover', label: '채우기' },
		{ mode: 'contain', label: '맞춤' },
		{ mode: 'fill', label: '확대' },
		{ mode: 'center', label: '가운데' },
		{ mode: 'tile', label: '바둑판식' }
	];

	const MAX_THUMBS = 60;

	let url = $state('');
	let mode = $state<WallpaperMode>('cover');

	let cached = $state<CachedImageInfo[]>([]);
	let totalCount = $state(0);
	/** url → thumbnail ObjectURL. */
	let thumbs = $state<Record<string, string>>({});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function applyUrl() {
		const u = url.trim();
		if (!u) return;
		onapply({ kind: 'url', url: u }, mode);
	}

	function applyCache(u: string) {
		onapply({ kind: 'cache', url: u }, mode);
	}

	// Load the cached-image list + thumbnails once on mount. Cap the grid at
	// MAX_THUMBS (most-recently-used first; listCached already sorts) and revoke
	// every thumbnail ObjectURL on teardown so the picker never leaks.
	$effect(() => {
		let cancelled = false;
		const created: string[] = [];
		void (async () => {
			const all = await listCached();
			if (cancelled) return;
			totalCount = all.length;
			const shown = all.slice(0, MAX_THUMBS);
			cached = shown;
			for (const info of shown) {
				const blob = await getBlob(info.url);
				if (cancelled) break;
				if (!blob) continue;
				const obj = URL.createObjectURL(blob);
				created.push(obj);
				thumbs = { ...thumbs, [info.url]: obj };
			}
		})();
		return () => {
			cancelled = true;
			for (const o of created) URL.revokeObjectURL(o);
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="bg-pick-backdrop" use:portal onclick={onclose}></div>

<div
	class="bg-pick"
	use:portal
	style="right: {anchor.right}px; bottom: {anchor.bottom}px;"
	role="dialog"
	aria-label="노트 배경 지정"
>
	<div class="url-row">
		<input
			class="url-input"
			type="text"
			placeholder="이미지 URL 붙여넣기"
			bind:value={url}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					applyUrl();
				}
			}}
		/>
		<button class="apply-btn" onclick={applyUrl}>적용</button>
	</div>

	<div class="modes" role="group" aria-label="표시 모드">
		{#each MODES as m (m.mode)}
			<button class="mode" class:active={mode === m.mode} onclick={() => (mode = m.mode)}>
				{m.label}
			</button>
		{/each}
	</div>

	{#if cached.length}
		<div class="cache-head">캐시 이미지에서 선택</div>
		<div class="grid">
			{#each cached as info (info.url)}
				<button class="thumb" aria-label={info.url} title={info.url} onclick={() => applyCache(info.url)}>
					{#if thumbs[info.url]}
						<img src={thumbs[info.url]} alt="" />
					{:else}
						<span class="thumb-ph" aria-hidden="true">🖼</span>
					{/if}
				</button>
			{/each}
		</div>
		{#if totalCount > MAX_THUMBS}
			<div class="cap-note">총 {totalCount}개 중 {MAX_THUMBS}개 표시</div>
		{/if}
	{/if}
</div>

<style>
	.bg-pick-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-menu);
	}
	.bg-pick {
		position: fixed;
		z-index: var(--z-menu);
		background: #fff;
		color: #111;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		width: 280px;
		max-width: calc(100vw - 16px);
		padding: 8px;
		font-size: 0.85rem;
	}
	.url-row {
		display: flex;
		gap: 6px;
	}
	.url-input {
		flex: 1;
		min-width: 0;
		padding: 5px 8px;
		border: 1px solid #d0d7de;
		border-radius: 4px;
		font-size: inherit;
	}
	.apply-btn {
		flex-shrink: 0;
		padding: 5px 12px;
		border: 1px solid #2d5a3d;
		background: #2d5a3d;
		color: #fff;
		border-radius: 4px;
		cursor: pointer;
		font-size: inherit;
	}
	.apply-btn:hover {
		opacity: 0.92;
	}
	.modes {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 8px;
	}
	.mode {
		flex: 1 0 auto;
		padding: 4px 8px;
		border: 1px solid #d0d7de;
		background: #fff;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
		color: inherit;
	}
	.mode:hover {
		background: #f0f3f7;
	}
	.mode.active {
		border-color: #2d5a3d;
		background: #e7f1ea;
		font-weight: 600;
	}
	.cache-head {
		margin-top: 10px;
		font-size: 0.75rem;
		color: #666;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 4px;
		margin-top: 4px;
		max-height: 200px;
		overflow-y: auto;
	}
	.thumb {
		aspect-ratio: 1;
		padding: 0;
		border: 1px solid #d0d7de;
		border-radius: 4px;
		background: #f6f8fa;
		cursor: pointer;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.thumb:hover {
		border-color: #2d5a3d;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.thumb-ph {
		opacity: 0.4;
		font-size: 1.1rem;
	}
	.cap-note {
		margin-top: 6px;
		font-size: 0.72rem;
		color: #888;
		text-align: right;
	}
</style>
