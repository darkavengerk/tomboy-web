<script lang="ts">
	interface Props {
		/** Current search text (controlled by the parent). */
		query: string;
		/** Total number of matches. */
		count: number;
		/** Index of the active match, or -1 when none. */
		activeIndex: number;
		onquery: (q: string) => void;
		onnext: () => void;
		onprev: () => void;
		onclose: () => void;
	}
	let { query, count, activeIndex, onquery, onnext, onprev, onclose }: Props = $props();

	let inputEl: HTMLInputElement | undefined = $state(undefined);

	// Focus + select the input as soon as the bar mounts, so a prefilled
	// query can be overtyped immediately.
	$effect(() => {
		if (inputEl) {
			inputEl.focus();
			inputEl.select();
		}
	});

	function handleInput(e: Event) {
		onquery((e.target as HTMLInputElement).value);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Ignore Enter/Escape while an IME composition is in flight — that
		// Enter confirms a Korean composition, it is not a navigation.
		if (e.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) onprev();
			else onnext();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
			// Bar already open — swallow the browser find shortcut and
			// just re-select the input text.
			e.preventDefault();
			inputEl?.select();
		}
	}
</script>

<div class="find-bar" role="search">
	<input
		bind:this={inputEl}
		class="find-input"
		type="text"
		placeholder="노트에서 찾기"
		value={query}
		oninput={handleInput}
		onkeydown={handleKeydown}
		aria-label="노트에서 찾기"
	/>
	<span class="find-count">
		{#if query === ''}{:else if count === 0}일치 없음{:else}{activeIndex + 1} / {count}{/if}
	</span>
	<button
		class="find-btn"
		onclick={onprev}
		disabled={count === 0}
		title="이전 (Shift+Enter)"
		aria-label="이전 일치"
	>↑</button>
	<button
		class="find-btn"
		onclick={onnext}
		disabled={count === 0}
		title="다음 (Enter)"
		aria-label="다음 일치"
	>↓</button>
	<button
		class="find-btn find-close"
		onclick={onclose}
		title="닫기 (Esc)"
		aria-label="찾기 닫기"
	>✕</button>
</div>

<style>
	.find-bar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		background: #fff;
		border: 1px solid #ccc;
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
	}
	.find-input {
		border: none;
		outline: none;
		font-size: 0.9rem;
		padding: 4px 6px;
		width: clamp(110px, 28vw, 190px);
		background: transparent;
		color: #222;
	}
	.find-count {
		font-size: 0.75rem;
		color: #666;
		white-space: nowrap;
		min-width: 3.4em;
		text-align: center;
	}
	.find-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: none;
		background: transparent;
		border-radius: 6px;
		font-size: 0.95rem;
		color: #444;
		cursor: pointer;
		flex-shrink: 0;
		-webkit-tap-highlight-color: transparent;
	}
	.find-btn:hover:not(:disabled) {
		background: #eee;
	}
	.find-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.find-close {
		color: #888;
	}
</style>
