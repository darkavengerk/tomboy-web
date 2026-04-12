<script lang="ts">
	interface Props {
		names: string[];
		selected: string | null;
		onselect: (n: string | null) => void;
	}

	let { names, selected, onselect }: Props = $props();
</script>

<div class="chips" role="tablist">
	<button
		role="tab"
		class="chip"
		class:active={selected === null}
		aria-selected={selected === null}
		onclick={() => onselect(null)}
	>
		전체
	</button>
	{#each names as name (name)}
		<button
			role="tab"
			class="chip"
			class:active={selected === name}
			aria-selected={selected === name}
			onclick={() => onselect(name)}
		>
			🗂 {name}
		</button>
	{/each}
</div>

<style>
	.chips {
		display: flex;
		gap: 8px;
		padding: 8px 16px;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		border-bottom: 1px solid var(--color-border, #eee);
		background: var(--color-bg, #fff);
		flex-shrink: 0;
	}

	.chips::-webkit-scrollbar {
		display: none;
	}

	.chip {
		flex-shrink: 0;
		padding: 4px 12px;
		border-radius: 16px;
		border: 1px solid var(--color-border, #ddd);
		background: var(--color-bg, #fff);
		font-size: 0.85rem;
		cursor: pointer;
		color: var(--color-text-secondary, #666);
		white-space: nowrap;
	}

	.chip.active {
		background: var(--color-primary, #1a73e8);
		color: white;
		border-color: var(--color-primary, #1a73e8);
	}
</style>
