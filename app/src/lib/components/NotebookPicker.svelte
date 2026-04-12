<script lang="ts">
	import { listNotebooks, createNotebook } from '$lib/core/notebooks.js';

	interface Props {
		current: string | null;
		onselect: (name: string | null) => void;
		onclose: () => void;
	}

	let { current, onselect, onclose }: Props = $props();

	let names = $state<string[]>([]);
	let newName = $state('');
	let creating = $state(false);

	$effect(() => {
		listNotebooks().then((n) => (names = n));
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	async function handleCreate() {
		const n = newName.trim();
		if (!n) return;
		creating = true;
		try {
			await createNotebook(n);
			newName = '';
			names = await listNotebooks();
			onselect(n);
		} finally {
			creating = false;
		}
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') handleCreate();
		e.stopPropagation(); // don't close sheet
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose}></div>

<div class="picker" role="dialog" aria-modal="true" aria-label="노트북 선택">
	<div class="picker-handle"></div>
	<div class="picker-title">노트북 선택</div>

	<div class="options">
		<button class="option" class:active={current === null} onclick={() => onselect(null)}>
			없음{current === null ? ' (선택됨)' : ''}
		</button>
		{#each names as n (n)}
			<button class="option" class:active={current === n} onclick={() => onselect(n)}>
				🗂 {n}{current === n ? ' (선택됨)' : ''}
			</button>
		{/each}
	</div>

	<div class="create-row">
		<input
			bind:value={newName}
			placeholder="새 노트북 이름"
			onkeydown={handleInputKeydown}
			onclick={(e) => e.stopPropagation()}
		/>
		<button class="create-btn" onclick={handleCreate} disabled={!newName.trim() || creating}>
			만들기
		</button>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: 200;
	}

	.picker {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: var(--color-bg, #fff);
		border-radius: 16px 16px 0 0;
		padding-bottom: calc(24px + var(--safe-area-bottom, 0px));
		z-index: 201;
		box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
		max-height: 70vh;
		display: flex;
		flex-direction: column;
	}

	.picker-handle {
		width: 40px;
		height: 4px;
		background: #ccc;
		border-radius: 2px;
		margin: 12px auto 8px;
		flex-shrink: 0;
	}

	.picker-title {
		padding: 0 20px 12px;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--color-text, #111);
		border-bottom: 1px solid var(--color-border, #eee);
		flex-shrink: 0;
	}

	.options {
		overflow-y: auto;
		flex: 1;
	}

	.option {
		display: block;
		width: 100%;
		padding: 14px 20px;
		font-size: 1rem;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--color-text, #111);
	}

	.option:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.option.active {
		color: var(--color-primary, #1a73e8);
		font-weight: 600;
	}

	.create-row {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--color-border, #eee);
		flex-shrink: 0;
	}

	.create-row input {
		flex: 1;
		padding: 8px 12px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 8px;
		font-size: 0.95rem;
		background: var(--color-bg, #fff);
		color: var(--color-text, #111);
	}

	.create-btn {
		padding: 8px 14px;
		background: var(--color-primary, #1a73e8);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.create-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
