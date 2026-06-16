<!--
  Shared per-note background image layer. A dedicated absolutely-positioned
  element (z-index:0, pointer-events:none) so it paints BEHIND the editor
  content (a later, positioned sibling) without intercepting input. Used by
  both NoteWindow (single note) and the note bundle stack (one per leaf), so
  the 5 display modes live here once instead of being copy-pasted.

  The host must be a positioned ancestor (position: relative) and place this
  before the content it should sit behind.
-->
<script lang="ts">
	import type { WallpaperMode } from './session.svelte.js';

	interface Props {
		/** ObjectURL (or any image URL) to paint. */
		url: string;
		/** Display mode — mirrors the workspace wallpaper modes. */
		mode: WallpaperMode;
		/** 0..1 — fades the image (NoteWindow ties this to window opacity). */
		opacity?: number;
	}

	let { url, mode, opacity = 1 }: Props = $props();
</script>

<div
	class="note-bg-layer"
	data-bg-mode={mode}
	style:background-image="url({url})"
	style:opacity
	aria-hidden="true"
></div>

<style>
	.note-bg-layer {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		user-select: none;
		background-repeat: no-repeat;
		background-position: center;
		background-size: contain;
	}
	.note-bg-layer[data-bg-mode='cover'] {
		background-size: cover;
	}
	.note-bg-layer[data-bg-mode='contain'] {
		background-size: contain;
	}
	.note-bg-layer[data-bg-mode='fill'] {
		background-size: 100% 100%;
	}
	.note-bg-layer[data-bg-mode='center'] {
		background-size: auto;
	}
	.note-bg-layer[data-bg-mode='tile'] {
		background-position: top left;
		background-repeat: repeat;
		background-size: auto;
	}
</style>
