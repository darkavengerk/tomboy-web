<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import type { SizeLevel } from './extensions/TomboySize.js';
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';

	interface Props {
		editor: Editor | null;
		onextractnote?: () => void;
		onuploadimage?: (file: File) => void;
	}

	let { editor, onextractnote, onuploadimage }: Props = $props();

	let fileInput: HTMLInputElement | undefined = $state(undefined);
	let drawerOpen = $state(false);
	let showSizeMenu = $state(false);

	const ctrlLocked = $derived(modKeys.ctrlLocked);

	function handleImageClick() {
		fileInput?.click();
	}

	function handleFileSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file && onuploadimage) {
			onuploadimage(file);
		}
		input.value = '';
	}

	function isActive(name: string, attrs?: Record<string, unknown>): boolean {
		if (!editor) return false;
		return editor.isActive(name, attrs);
	}

	function toggleBold() { editor?.chain().focus().toggleBold().run(); }
	function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
	function toggleUnderline() { editor?.chain().focus().toggleUnderline().run(); }
	function toggleStrike() { editor?.chain().focus().toggleStrike().run(); }
	function toggleHighlight() { editor?.chain().focus().toggleHighlight().run(); }
	function toggleMonospace() { editor?.chain().focus().toggleTomboyMonospace().run(); }
	function toggleBulletList() { editor?.chain().focus().toggleBulletList().run(); }
	function toggleSize(level: SizeLevel) {
		editor?.chain().focus().toggleTomboySize(level).run();
		showSizeMenu = false;
	}

	function toggleDrawer() {
		drawerOpen = !drawerOpen;
		if (!drawerOpen) showSizeMenu = false;
	}
</script>

<div class="toolbar-wrap">
	<div class="drawer" class:open={drawerOpen} role="toolbar" aria-label="서식 도구">
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

		<button class:active={isActive('bulletList')} onclick={toggleBulletList} title="Bullet List">
			•
		</button>

		{#if onuploadimage}
			<button class="icon-btn" onclick={handleImageClick} title="이미지 업로드">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
					<circle cx="8.5" cy="8.5" r="1.5" />
					<polyline points="21 15 16 10 5 21" />
				</svg>
			</button>
			<input
				bind:this={fileInput}
				type="file"
				accept="image/*"
				style="display: none"
				onchange={handleFileSelected}
			/>
		{/if}

		{#if onextractnote}
			<button class="icon-btn" onclick={() => onextractnote?.()} title="선택 영역을 새 노트로">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<polyline points="14 2 14 8 20 8" />
					<line x1="12" y1="18" x2="12" y2="12" />
					<line x1="9" y1="15" x2="15" y2="15" />
				</svg>
			</button>
		{/if}
	</div>

	<div class="dock">
		<button
			class="ctrl-toggle"
			class:active={ctrlLocked}
			onclick={() => modKeys.toggleCtrlLock()}
			title="Ctrl 고정 — 데스크탑의 Ctrl-hold 동작을 모바일에서도 사용"
			aria-pressed={ctrlLocked}
		>
			<span class="ctrl-label">Ctrl</span>
			<span class="ctrl-dot" aria-hidden="true"></span>
		</button>

		<button
			class="drawer-toggle"
			onclick={toggleDrawer}
			aria-expanded={drawerOpen}
			title={drawerOpen ? '서식 도구 닫기' : '서식 도구 열기'}
		>
			<span class="drawer-label">서식</span>
			<span class="chevron" class:open={drawerOpen} aria-hidden="true">▲</span>
		</button>
	</div>
</div>

<style>
	.toolbar-wrap {
		display: flex;
		flex-direction: column;
		border-top: 1px solid #dee2e6;
		background: #f8f9fa;
		flex-shrink: 0;
	}

	.drawer {
		display: none;
		align-items: center;
		gap: 2px;
		padding: 6px 8px;
		border-bottom: 1px solid #dee2e6;
		background: #f8f9fa;
		overflow-x: auto;
	}

	.drawer.open {
		display: flex;
	}

	.drawer button {
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
		flex-shrink: 0;
	}

	.drawer button:active {
		background: #dee2e6;
	}

	.drawer button.active {
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

	.size-huge { font-size: 1.4em; font-weight: bold; }
	.size-large { font-size: 1.15em; }
	.size-small { font-size: 0.85em; }

	/* --- Dock row (always visible) --- */
	.dock {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 10px;
		min-height: 40px;
	}

	.ctrl-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid #ced4da;
		background: #fff;
		color: #495057;
		border-radius: 999px;
		padding: 4px 12px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.ctrl-label {
		letter-spacing: 0.02em;
	}

	.ctrl-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #ced4da;
		transition: background-color 0.15s ease;
	}

	.ctrl-toggle.active {
		background: #1971c2;
		border-color: #1971c2;
		color: #fff;
		box-shadow: 0 0 0 2px rgba(25, 113, 194, 0.25);
	}

	.ctrl-toggle.active .ctrl-dot {
		background: #ffec99;
	}

	.drawer-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: none;
		background: transparent;
		color: #495057;
		padding: 4px 10px;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.drawer-toggle:active {
		background: #dee2e6;
	}

	.drawer-label {
		letter-spacing: 0.02em;
	}

	.chevron {
		display: inline-block;
		transition: transform 0.15s ease;
		font-size: 0.7rem;
		line-height: 1;
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	/* Desktop (fine pointer): always show the drawer and hide the dock.
	   A keyboard user has Ctrl natively and doesn't need the lock toggle,
	   and the extra 서식 toggle click is pure friction on a mouse. */
	@media (pointer: fine) {
		.drawer {
			display: flex;
			padding: 2px 6px;
			gap: 1px;
			border-bottom: none;
		}
		.drawer button {
			min-width: 28px;
			height: 28px;
			font-size: 13px;
			border-radius: 4px;
		}
		.dock {
			display: none;
		}
	}

	.icon-btn {
		color: #495057;
	}
</style>
