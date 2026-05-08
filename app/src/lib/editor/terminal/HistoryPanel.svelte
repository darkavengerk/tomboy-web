<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		count: number;
		items: string[];
		onsend: (text: string) => void;
		onsendNow: (text: string) => void;
		ondelete: (index: number) => void;
		onclear: () => void;
		onclose: () => void;
		onedit: () => void;
	};
	let { count, items, onsend, onsendNow, ondelete, onclear, onclose, onedit }: Props = $props();

	let menuOpenIndex: number | null = $state(null);
	let menuX = $state(0);
	let menuY = $state(0);
	let pulseIndex: number | null = $state(null);

	function pulse(index: number): void {
		pulseIndex = index;
		setTimeout(() => {
			if (pulseIndex === index) pulseIndex = null;
		}, 200);
	}

	function handleClick(ev: MouseEvent, index: number): void {
		if ((ev.target as HTMLElement).closest('.menu')) return;
		const text = items[index];
		if (!text) return;
		pulse(index);
		if (ev.shiftKey) onsendNow(text);
		else onsend(text);
	}

	function handleContextMenu(ev: MouseEvent, index: number): void {
		ev.preventDefault();
		menuOpenIndex = index;
		menuX = ev.clientX;
		menuY = ev.clientY;
	}

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	function handlePointerDown(ev: PointerEvent, index: number): void {
		if (ev.pointerType !== 'touch') return;
		pressTimer = setTimeout(() => {
			menuOpenIndex = index;
			menuX = ev.clientX;
			menuY = ev.clientY;
			if ('vibrate' in navigator) navigator.vibrate(20);
			pressTimer = null;
		}, 500);
	}
	function handlePointerUp(): void {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
	}

	function copy(text: string): void {
		void navigator.clipboard.writeText(text);
		menuOpenIndex = null;
	}

	async function confirmClear(): Promise<void> {
		if (confirm('히스토리를 모두 삭제할까요?')) {
			onclear();
		}
	}

	function closeMenu(): void {
		menuOpenIndex = null;
	}

	onMount(() => {
		const onDocClick = (ev: MouseEvent) => {
			if (menuOpenIndex !== null) {
				const t = ev.target as HTMLElement;
				if (!t.closest('.menu')) closeMenu();
			}
		};
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});
</script>

<div class="history-panel" role="region" aria-label="명령어 히스토리">
	<div class="panel-header">
		<span class="title">히스토리 <span class="count">{count}</span></span>
		<div class="actions">
			<button type="button" class="icon-btn" title="비우기" onclick={confirmClear}>⌫</button>
			<button type="button" class="icon-btn" title="닫기" onclick={onclose}>×</button>
		</div>
	</div>
	<ul class="items">
		{#if items.length === 0}
			<li class="empty">기록된 명령어가 없습니다</li>
		{:else}
			{#each items as text, index (index + ':' + text)}
				<li
					class="item"
					class:pulse={pulseIndex === index}
					title={text}
					onclick={(e) => handleClick(e, index)}
					oncontextmenu={(e) => handleContextMenu(e, index)}
					onpointerdown={(e) => handlePointerDown(e, index)}
					onpointerup={handlePointerUp}
					onpointercancel={handlePointerUp}
					role="button"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter') handleClick(e as unknown as MouseEvent, index);
					}}
				>
					{text}
				</li>
			{/each}
		{/if}
	</ul>

	{#if menuOpenIndex !== null}
		<div class="menu" style="left:{menuX}px; top:{menuY}px;" role="menu">
			<button type="button" onclick={() => { copy(items[menuOpenIndex!]); }}>복사</button>
			<button type="button" onclick={() => { ondelete(menuOpenIndex!); closeMenu(); }}>삭제</button>
			<button type="button" onclick={() => { onedit(); closeMenu(); }}>편집 모드</button>
		</div>
	{/if}
</div>

<style>
	.history-panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: #232323;
		color: #ddd;
		border-left: 1px solid #111;
	}
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 8px;
		background: #2a2a2a;
		border-bottom: 1px solid #111;
	}
	.title { font-size: 0.78rem; }
	.count {
		display: inline-block;
		padding: 0 6px;
		border-radius: 8px;
		background: #444;
		color: #ddd;
		font-size: 0.7rem;
		margin-left: 4px;
	}
	.actions { display: flex; gap: 2px; }
	.icon-btn {
		background: transparent;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 2px 6px;
		border-radius: 3px;
	}
	.icon-btn:hover { background: #3a3a3a; color: #fff; }

	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.empty {
		color: #666;
		font-size: 0.8rem;
		padding: 8px;
		text-align: center;
	}
	.item {
		padding: 4px 8px;
		font-size: 0.78rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		transition: background 0.05s;
	}
	.item:hover { background: #2f2f2f; }
	.item.pulse { animation: pulse 0.2s ease-out; }
	@keyframes pulse {
		0% { background: #4a6a9c; }
		100% { background: transparent; }
	}

	.menu {
		position: fixed;
		background: #2f2f2f;
		border: 1px solid #555;
		border-radius: 4px;
		padding: 2px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		z-index: 100;
		min-width: 100px;
	}
	.menu button {
		background: transparent;
		border: none;
		color: #ddd;
		text-align: left;
		padding: 4px 10px;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.menu button:hover { background: #3a4a6a; }
</style>
