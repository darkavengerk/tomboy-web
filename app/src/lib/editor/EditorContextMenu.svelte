<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { pushToast } from '$lib/stores/toast.js';
	import { insertTodayDate } from './insertDate.js';
	import { sinkListItemOnly, liftListItemOnly } from './listItemDepth.js';
	import { moveListItemUp, moveListItemDown } from './listItemReorder.js';
	import {
		tiptapToHtml,
		tiptapToPlainText,
		tiptapToStructuredText,
		tiptapToMarkdown,
		copySelectionAsJson
	} from './copyFormatted.js';

	interface Props {
		editor: Editor;
		x: number;
		y: number;
		onclose: () => void;
		oninternallink?: (target: string) => void;
		onuploadfile?: (file: File) => void;
		onsendremarkable?: () => void;
	}

	let { editor, x, y, onclose, oninternallink, onuploadfile, onsendremarkable }: Props = $props();

	let formatSubmenuOpen = $state(false);

	// Detect whether cursor is inside a list node.
	const inList = $derived.by(() => {
		const selFrom = editor.state.selection.$from;
		for (let d = selFrom.depth; d >= 0; d--) {
			const n = selFrom.node(d);
			if (n.type === editor.schema.nodes.bulletList || n.type === editor.schema.nodes.orderedList) {
				return true;
			}
		}
		return false;
	});

	// Derive link info from the cursor marks so "링크 열기" shows when hovering a link.
	const linkInfo = $derived.by(() => {
		const selFrom = editor.state.selection.$from;
		const marks = selFrom.marks();
		for (const m of marks) {
			if (m.type === editor.schema.marks.tomboyUrlLink) {
				return { kind: 'url' as const, href: String(m.attrs.href ?? '') };
			}
			if (m.type === editor.schema.marks.tomboyInternalLink) {
				return { kind: 'internal' as const, target: String(m.attrs.target ?? '') };
			}
		}
		return null;
	});

	function close() {
		onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}

	async function doCut() {
		close();
		try {
			document.execCommand('cut');
		} catch {
			pushToast('잘라내기 실패', { kind: 'error' });
		}
	}

	async function doCopy() {
		close();
		const json = copySelectionAsJson(editor);
		const html = tiptapToHtml(json);
		const plain = tiptapToPlainText(json);
		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([html], { type: 'text/html' }),
					'text/plain': new Blob([plain], { type: 'text/plain' })
				})
			]);
		} catch {
			// Fallback: plain text only
			try {
				await navigator.clipboard.writeText(plain);
			} catch {
				pushToast('복사 실패', { kind: 'error' });
			}
		}
	}

	async function copyAs(format: 'html' | 'plain' | 'structured' | 'markdown') {
		close();
		const json = copySelectionAsJson(editor);
		let text: string;
		if (format === 'html') text = tiptapToHtml(json);
		else if (format === 'plain') text = tiptapToPlainText(json);
		else if (format === 'structured') text = tiptapToStructuredText(json);
		else text = tiptapToMarkdown(json);
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			pushToast('복사 실패', { kind: 'error' });
		}
	}

	async function doPaste() {
		close();
		if (!navigator.clipboard) {
			pushToast('붙여넣기 실패 — 브라우저가 허용하지 않음', { kind: 'error' });
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			editor.commands.insertContent(text);
		} catch {
			pushToast('붙여넣기 실패 — 브라우저가 허용하지 않음', { kind: 'error' });
		}
	}

	function doInsertDate() {
		close();
		insertTodayDate(editor);
	}

	function doToggleList() {
		close();
		editor.chain().focus().toggleBulletList().run();
	}

	function doLift() {
		close();
		liftListItemOnly(editor);
	}

	function doSink() {
		close();
		sinkListItemOnly(editor);
	}

	function doMoveUp() {
		close();
		moveListItemUp(editor);
	}

	function doMoveDown() {
		close();
		moveListItemDown(editor);
	}

	function doOpenLink() {
		close();
		const info = linkInfo;
		if (!info) return;
		if (info.kind === 'url') {
			window.open(info.href, '_blank', 'noopener');
		} else {
			oninternallink?.(info.target);
		}
	}

	// 파일 첨부: spin up a transient <input type=file>, trigger it, and pass
	// the selected file to the parent callback. The input is appended to
	// document.body so the click is treated as a user-gesture; it's removed
	// via either the onchange handler (file picked) or the oncancel handler
	// (picker dismissed without selection) so the element never leaks.
	function openFilePicker() {
		if (!onuploadfile) return;
		const input = document.createElement('input');
		input.type = 'file';
		input.style.display = 'none';
		input.onchange = (e: Event) => {
			const target = e.target as HTMLInputElement;
			const file = target.files?.[0];
			if (file) onuploadfile?.(file);
			target.value = '';
			input.remove();
		};
		input.oncancel = () => input.remove();
		document.body.appendChild(input);
		input.click();
		close();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-backdrop" onclick={close}></div>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="ctx-menu"
	style="left:{x}px; top:{y}px;"
	role="menu"
>
	<button class="item" onclick={doCut}>잘라내기</button>
	<button class="item" onclick={doCopy}>복사</button>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="item has-sub"
		role="menuitem"
		tabindex="0"
		onmouseenter={() => (formatSubmenuOpen = true)}
		onmouseleave={() => (formatSubmenuOpen = false)}
		onfocus={() => (formatSubmenuOpen = true)}
		onblur={() => (formatSubmenuOpen = false)}
	>
		형식 복사
		<span class="arrow">›</span>
		{#if formatSubmenuOpen}
			<div class="submenu" role="menu">
				<button class="item" onclick={() => copyAs('html')}>HTML</button>
				<button class="item" onclick={() => copyAs('plain')}>일반 텍스트</button>
				<button class="item" onclick={() => copyAs('structured')}>리스트 형식 유지</button>
				<button class="item" onclick={() => copyAs('markdown')}>Markdown</button>
			</div>
		{/if}
	</div>

	<button class="item" onclick={doPaste}>붙여넣기</button>
	<div class="sep"></div>
	<button class="item" onclick={doInsertDate}>오늘 날짜 삽입</button>
	{#if onuploadfile}
		<button class="item" onclick={openFilePicker}>파일 첨부</button>
	{/if}
	<button class="item" onclick={doToggleList}>리스트로 만들기</button>
	{#if inList}
		<button class="item" onclick={doLift}>깊이 ↑ (Alt+←)</button>
		<button class="item" onclick={doSink}>깊이 ↓ (Alt+→)</button>
		<button class="item" onclick={doMoveUp}>위로 이동 (Alt+↑)</button>
		<button class="item" onclick={doMoveDown}>아래로 이동 (Alt+↓)</button>
	{/if}
	{#if linkInfo}
		<div class="sep"></div>
		<button class="item" onclick={doOpenLink}>링크 열기</button>
	{/if}
	{#if onsendremarkable}
		<div class="sep"></div>
		<button
			class="item"
			onclick={() => {
				close();
				onsendremarkable?.();
			}}>리마커블로 보내기</button
		>
	{/if}
</div>

<style>
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-menu);
	}
	.ctx-menu {
		position: fixed;
		z-index: var(--z-menu);
		background: #fff;
		color: #111;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		min-width: 180px;
		padding: 4px;
		font-size: 0.85rem;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 10px;
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
	.has-sub {
		position: relative;
		user-select: none;
	}
	.arrow {
		margin-left: auto;
		font-size: 1rem;
		line-height: 1;
	}
	.submenu {
		position: absolute;
		left: 100%;
		top: 0;
		background: #fff;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
		min-width: 140px;
		padding: 4px;
		/* 로컬: .ctx-menu(var(--z-menu)) 가 stacking context 라 형제 항목 위로만 뜨면 됨 */
		z-index: 1;
	}
	.sep {
		height: 1px;
		background: #e4e8ec;
		margin: 4px 2px;
	}
</style>
