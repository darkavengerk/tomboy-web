<script lang="ts">
	import { toasts, dismissToast } from '$lib/stores/toast.js';
</script>

<div class="toast-layer" aria-live="polite">
	{#each $toasts as t (t.id)}
		<button class="toast" data-kind={t.kind ?? 'info'} onclick={() => dismissToast(t.id)}>
			{t.message}
		</button>
	{/each}
</div>

<style>
	.toast-layer {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(16px + var(--safe-area-bottom, 0px));
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		pointer-events: none;
		z-index: 1000;
	}

	.toast {
		pointer-events: auto;
		background: #333;
		color: white;
		border-radius: 999px;
		padding: 10px 16px;
		font-size: 0.9rem;
		border: none;
		cursor: pointer;
		max-width: calc(100vw - 32px);
	}

	.toast[data-kind='error'] {
		background: #c92a2a;
	}
</style>
