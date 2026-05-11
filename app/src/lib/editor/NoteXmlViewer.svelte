<script lang="ts">
	import { portal } from '$lib/utils/portal.js';
	import { pushToast } from '$lib/stores/toast.js';

	interface Props {
		title: string;
		xml: string;
		onclose: () => void;
	}

	let { title, xml, onclose }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(xml);
			pushToast('XML 복사됨');
		} catch {
			pushToast('복사 실패', { kind: 'error' });
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" use:portal onclick={onclose}></div>

<div class="dialog" use:portal role="dialog" aria-modal="true" aria-labelledby="xml-viewer-title">
	<div class="header">
		<h2 id="xml-viewer-title" class="title">원본 XML</h2>
		<div class="subtitle">{title || '제목 없음'}</div>
	</div>
	<pre class="body">{xml}</pre>
	<div class="footer">
		<span class="size-hint">{xml.length.toLocaleString('ko-KR')}자</span>
		<button type="button" class="btn" onclick={copyToClipboard}>복사</button>
		<button type="button" class="btn primary" onclick={onclose}>닫기</button>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		z-index: 400;
	}
	.dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 401;
		background: var(--color-bg, #fff);
		color: var(--color-text, #111);
		border-radius: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
		display: flex;
		flex-direction: column;
		width: 95vw;
		max-width: 900px;
		max-height: min(80vh, 700px);
	}
	.header {
		padding: 16px 20px 10px;
		border-bottom: 1px solid var(--color-border, #eee);
	}
	.title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.subtitle {
		font-size: 0.82rem;
		color: var(--color-text-secondary, #666);
		margin-top: 4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.body {
		flex: 1;
		overflow: auto;
		margin: 0;
		padding: 14px 20px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.78rem;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-all;
		background: var(--color-bg-secondary, #f6f8fa);
	}
	.footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 10px;
		padding: 12px 20px;
		border-top: 1px solid var(--color-border, #eee);
	}
	.size-hint {
		margin-right: auto;
		font-size: 0.78rem;
		color: var(--color-text-secondary, #666);
	}
	.btn {
		padding: 6px 14px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 4px;
		background: var(--color-bg, #fff);
		color: inherit;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.btn:hover {
		background: var(--color-bg-secondary, #f5f5f5);
	}
	.btn.primary {
		background: var(--color-primary, #0969da);
		color: #fff;
		border-color: transparent;
	}
	.btn.primary:hover {
		filter: brightness(1.05);
	}
</style>
