<!--
  Note title handle shown left of the title in both title bars.
  - Desktop (draggable): drag onto another note's editor → the title drops in as
    plain text at the drop point (see noteTitleDropPlugin). Default drag image is
    this icon, so "only the icon follows".
  - Both: click → copy the title to the clipboard.
  Icon is an inline SVG using `currentColor`, so it stays crisp on both the dark
  desktop window header and the light mobile title bar.
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
	aria-label="노트 제목 복사 또는 드래그">
	<svg
		class="note-drag-icon"
		viewBox="0 0 24 24"
		width="18"
		height="18"
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true">
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
		<path d="M14 3v5h5" />
		<line x1="9" y1="13" x2="15" y2="13" />
		<line x1="9" y1="17" x2="13" y2="17" />
	</svg>
</button>

<style>
	.note-drag-handle {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: none;
		color: inherit;
		cursor: pointer;
		/* 좌우 패딩 제거 — 아이콘이 제목에서 붕 뜨지 않게. 세로 패딩만 둬 탭 영역 확보.
		   양옆 간격은 타이틀바의 flex gap 으로만 — 완전히 붙지는 않는다. */
		padding: 2px 0;
		line-height: 0;
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
	.note-drag-icon {
		display: block;
	}
</style>
