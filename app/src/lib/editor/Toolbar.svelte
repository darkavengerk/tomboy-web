<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import type { SizeLevel } from './extensions/TomboySize.js';

	interface Props {
		editor: Editor | null;
		onextractnote?: () => void;
	}

	let { editor, onextractnote }: Props = $props();

	let showSizeMenu = $state(false);

	function isActive(name: string, attrs?: Record<string, unknown>): boolean {
		if (!editor) return false;
		return editor.isActive(name, attrs);
	}

	function toggleBold() {
		editor?.chain().focus().toggleBold().run();
	}

	function toggleItalic() {
		editor?.chain().focus().toggleItalic().run();
	}

	function toggleUnderline() {
		editor?.chain().focus().toggleUnderline().run();
	}

	function toggleStrike() {
		editor?.chain().focus().toggleStrike().run();
	}

	function toggleHighlight() {
		editor?.chain().focus().toggleHighlight().run();
	}

	function toggleMonospace() {
		editor?.chain().focus().toggleTomboyMonospace().run();
	}

	function toggleSize(level: SizeLevel) {
		editor?.chain().focus().toggleTomboySize(level).run();
		showSizeMenu = false;
	}

	function toggleBulletList() {
		editor?.chain().focus().toggleBulletList().run();
	}
</script>

<div class="toolbar">
	<button class:active={isActive('bold')} onclick={toggleBold} title="Bold (Ctrl+B)">
		<strong>B</strong>
	</button>
	<button class:active={isActive('italic')} onclick={toggleItalic} title="Italic (Ctrl+I)">
		<em>I</em>
	</button>
	<button class:active={isActive('underline')} onclick={toggleUnderline} title="Underline (Ctrl+U)">
		<u>U</u>
	</button>
	<button class:active={isActive('strike')} onclick={toggleStrike} title="Strikethrough (Ctrl+S)">
		<s>S</s>
	</button>
	<button class:active={isActive('highlight')} onclick={toggleHighlight} title="Highlight (Ctrl+H)">
		<span class="highlight-icon">H</span>
	</button>
	<button class:active={isActive('tomboyMonospace')} onclick={toggleMonospace} title="Monospace (Ctrl+M)">
		<code>M</code>
	</button>

	<div class="size-dropdown">
		<button onclick={() => (showSizeMenu = !showSizeMenu)} title="Text Size">
			Aa
		</button>
		{#if showSizeMenu}
			<div class="size-menu">
				<button class:active={isActive('tomboySize', { level: 'huge' })} onclick={() => toggleSize('huge')}>
					<span class="size-huge">Huge</span>
				</button>
				<button class:active={isActive('tomboySize', { level: 'large' })} onclick={() => toggleSize('large')}>
					<span class="size-large">Large</span>
				</button>
				<button class:active={isActive('tomboySize', { level: 'small' })} onclick={() => toggleSize('small')}>
					<span class="size-small">Small</span>
				</button>
			</div>
		{/if}
	</div>

	<button class:active={isActive('bulletList')} onclick={toggleBulletList} title="Bullet List (Ctrl+L)">
		•
	</button>

	{#if onextractnote}
		<button class="extract-btn" onclick={() => onextractnote?.()} title="선택 영역을 새 노트로">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
				<polyline points="14 2 14 8 20 8" />
				<line x1="12" y1="18" x2="12" y2="12" />
				<line x1="9" y1="15" x2="15" y2="15" />
			</svg>
		</button>
	{/if}
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 6px 8px;
		background: #f8f9fa;
		border-top: 1px solid #dee2e6;
		overflow-x: auto;
		flex-shrink: 0;
	}

	.toolbar button {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 36px;
		height: 36px;
		border: none;
		background: transparent;
		border-radius: 6px;
		font-size: 15px;
		color: #495057;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	/* Desktop (fine pointer): shrink toolbar — touch targets not needed. */
	@media (pointer: fine) {
		.toolbar {
			padding: 2px 6px;
			gap: 1px;
		}
		.toolbar button {
			min-width: 28px;
			height: 28px;
			font-size: 13px;
			border-radius: 4px;
		}
	}

	.toolbar button:active {
		background: #dee2e6;
	}

	.toolbar button.active {
		background: #d0ebff;
		color: #1971c2;
	}

	.highlight-icon {
		background: #fff176;
		padding: 0 4px;
		border-radius: 2px;
	}

	code {
		font-family: monospace;
		font-size: 13px;
	}

	.size-dropdown {
		position: relative;
	}

	.size-menu {
		position: absolute;
		bottom: 100%;
		left: 0;
		background: white;
		border: 1px solid #dee2e6;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		z-index: 10;
	}

	.size-menu button {
		width: 100%;
		text-align: left;
		padding: 6px 12px;
		white-space: nowrap;
	}

	.size-huge {
		font-size: 1.4em;
		font-weight: bold;
	}

	.size-large {
		font-size: 1.15em;
	}

	.size-small {
		font-size: 0.85em;
	}
</style>
