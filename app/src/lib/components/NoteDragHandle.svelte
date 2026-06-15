<!--
  Note title handle shown left of the title in both title bars.
  - Desktop (draggable): drag onto another note's editor → the title drops in as
    plain text at the drop point (see noteTitleDropPlugin). Default drag image is
    this icon, so "only the icon follows".
  - Both: click → copy the title to the clipboard.
  `data-no-drag` keeps the desktop NoteWindow's window-move pointer-drag from
  firing on this element.
-->
<script lang="ts">
	import { pushToast } from '$lib/stores/toast.js';
	import { NOTE_TITLE_DND_MIME } from '$lib/editor/noteTitleDrop/noteTitleDropPlugin.js';

	let { title, draggable = false }: { title: string; draggable?: boolean } = $props();

	function onDragStart(e: DragEvent) {
		if (!e.dataTransfer || !title) return;
		e.dataTransfer.setData(NOTE_TITLE_DND_MIME, title);
		e.dataTransfer.setData('text/plain', title);
		e.dataTransfer.effectAllowed = 'copy';
	}

	async function onClick() {
		if (!title) return;
		try {
			await navigator.clipboard.writeText(title);
			pushToast('제목이 복사되었습니다.');
		} catch {
			pushToast('복사에 실패했습니다.', { kind: 'error' });
		}
	}
</script>

<button
	type="button"
	class="note-drag-handle"
	class:draggable
	{draggable}
	data-no-drag
	onclick={onClick}
	ondragstart={onDragStart}
	title={draggable ? '드래그해 다른 노트에 제목 넣기 · 클릭해 복사' : '클릭해 제목 복사'}
	aria-label="노트 제목 복사 또는 드래그">📄</button>

<style>
	.note-drag-handle {
		flex-shrink: 0;
		border: none;
		background: none;
		cursor: pointer;
		font-size: 1.15rem;
		line-height: 1;
		padding: 2px 4px;
		user-select: none;
		opacity: 0.85;
	}
	.note-drag-handle.draggable {
		cursor: grab;
	}
	.note-drag-handle.draggable:active {
		cursor: grabbing;
	}
	.note-drag-handle:hover {
		opacity: 1;
	}
</style>
