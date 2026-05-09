<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		count: number;
		items: string[];
		pinned: string[];
		bucketLabel: string;
		onsend: (text: string) => void;
		onsendNow: (text: string) => void;
		ondelete: (index: number) => void;
		onclear: () => void;
		onclose: () => void;
		onedit: () => void;
		onpin: (text: string) => void;
		onunpin: (text: string) => void;
	};
	let { count, items, pinned, bucketLabel, onsend, onsendNow, ondelete, onclear, onclose, onedit, onpin, onunpin }: Props = $props();

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
		if ((ev.target as HTMLElement).closest('.row-delete')) return;
		if ((ev.target as HTMLElement).closest('.row-pin')) return;
		const text = items[index];
		if (!text) return;
		pulse(index);
		if (ev.shiftKey) onsendNow(text);
		else onsend(text);
	}

	function handlePinnedClick(ev: MouseEvent, text: string): void {
		if ((ev.target as HTMLElement).closest('.menu')) return;
		if ((ev.target as HTMLElement).closest('.row-delete')) return;
		if ((ev.target as HTMLElement).closest('.row-pin')) return;
		if (!text) return;
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
		if ((ev.target as HTMLElement).closest('.row-delete')) return;
		if ((ev.target as HTMLElement).closest('.row-pin')) return;
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
		<span class="title">
			히스토리 <span class="bucket">{bucketLabel}</span> <span class="count">{count}</span>
		</span>
		<div class="actions">
			<button type="button" class="icon-btn" title="비우기" onclick={confirmClear}>⌫</button>
			<button type="button" class="icon-btn" title="닫기" onclick={onclose}>×</button>
		</div>
	</div>
	<ul class="items">
		{#each pinned as text (('pinned:' + text))}
			<li
				class="item item-pinned"
				title={text}
				onclick={(e) => handlePinnedClick(e, text)}
				onpointerup={handlePointerUp}
				onpointercancel={handlePointerUp}
				role="button"
				tabindex="0"
				onkeydown={(e) => {
					if (e.key === 'Enter') handlePinnedClick(e as unknown as MouseEvent, text);
				}}
			>
				<button
					type="button"
					class="row-pin pinned"
					aria-label="고정 해제"
					title="고정 해제"
					onclick={(e) => { e.stopPropagation(); onunpin(text); }}
				>★</button>
				<span class="text">{text}</span>
			</li>
		{/each}
		{#if pinned.length > 0 && items.length > 0}
			<li class="section-label" aria-hidden="true">히스토리</li>
		{/if}
		{#if items.length === 0 && pinned.length === 0}
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
					<button
						type="button"
						class="row-pin"
						aria-label="고정"
						title="고정"
						onclick={(e) => { e.stopPropagation(); onpin(text); }}
					>☆</button>
					<span class="text">{text}</span>
					<button
						type="button"
						class="row-delete"
						aria-label="삭제"
						title="삭제"
						onclick={(e) => { e.stopPropagation(); ondelete(index); }}
					>×</button>
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
	.bucket {
		display: inline-block;
		padding: 0 6px;
		border-radius: 8px;
		background: #345470;
		color: #cfe1ff;
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
		display: flex;
		align-items: center;
		padding: 4px 4px 4px 4px;
		font-size: 0.78rem;
		cursor: pointer;
		transition: background 0.05s;
	}
	.item:hover { background: #2f2f2f; }
	.item-pinned { background: #1e2a1e; }
	.item-pinned:hover { background: #253525; }
	.section-label {
		font-size: 0.68rem;
		color: #555;
		padding: 3px 8px 2px;
		border-top: 1px solid #333;
		letter-spacing: 0.04em;
		list-style: none;
		user-select: none;
	}
	.text {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row-pin {
		flex-shrink: 0;
		background: transparent;
		border: none;
		color: #666;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 2px 4px;
		min-width: 22px;
		min-height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		transition: color 0.1s;
	}
	.row-pin.pinned { color: #d6b34a; }
	.row-pin:not(.pinned):hover { color: #c9a830; }
	.row-delete {
		flex-shrink: 0;
		background: transparent;
		border: none;
		color: #666;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 2px 6px;
		min-width: 24px;
		min-height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		opacity: 0;
		transition: opacity 0.1s, color 0.1s;
	}
	.item:hover .row-delete { opacity: 1; }
	.row-delete:hover { color: #f88; }
	@media (pointer: coarse) {
		.row-delete { opacity: 1; }
	}
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
