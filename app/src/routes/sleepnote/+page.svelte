<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	const SLEEP_NOTE_GUID = '1c97d161-1489-4c32-93d9-d8c383330b9c';

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
