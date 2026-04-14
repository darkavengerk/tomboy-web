<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SLEEP_NOTE_GUID } from '$lib/graph/constants.js';

	onMount(() => {
		goto(`/note/${SLEEP_NOTE_GUID}?from=sleepnote`, { replaceState: true });
	});
</script>

<div class="loading">로딩 중...</div>

<style>
	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--color-text-secondary);
	}
</style>
