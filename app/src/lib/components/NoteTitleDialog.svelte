<script lang="ts">
	import { onMount } from 'svelte';
	import { NOTE_TYPES, getNoteType } from '$lib/noteTypes/registry.js';
	import { portal } from '$lib/utils/portal.js';

	export interface Stage {
		name: string;
		ms: number | null;
		status: 'pending' | 'active' | 'done';
	}

	interface Props {
		mode: 'create' | 'edit';
		notebooks: string[];
		initialTitle?: string;
		initialNotebook?: string | null;
		/** 진행 단계가 주어지면 입력 폼 대신 진행 뷰를 표시. */
		progressStages?: Stage[];
		onsubmit: (r: { title: string; typeId: string; notebook: string | null }) => void;
		oncancel: () => void;
	}

	let {
		mode,
		notebooks,
		initialTitle = '',
		initialNotebook = null,
		progressStages,
		onsubmit,
		oncancel
	}: Props = $props();

	let title = $state(initialTitle);
	let typeId = $state('plain');
	let notebook = $state<string | null>(initialNotebook);
	let titleInputEl = $state<HTMLInputElement>();

	const showProgress = $derived(!!progressStages && progressStages.length > 0);
	const helpText = $derived(getNoteType(typeId)?.help ?? '');
	const canSubmit = $derived(title.trim().length > 0);
	const confirmLabel = $derived(mode === 'create' ? '만들기' : '저장');

	onMount(() => { titleInputEl?.focus(); });

	function submit() {
		if (!canSubmit) return;
		onsubmit({ title: title.trim(), typeId, notebook });
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') oncancel();
		else if (e.key === 'Enter' && canSubmit) submit();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" use:portal onclick={() => !showProgress && oncancel()}></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="note-title-dialog-heading" use:portal>
	{#if showProgress}
		<div class="dlg-title" id="note-title-dialog-heading">{mode === 'create' ? '새 노트 만드는 중…' : '수정 중…'}</div>
		<ul class="stages">
			{#each progressStages! as s (s.name)}
				<li class="stage" class:active={s.status === 'active'} class:done={s.status === 'done'}>
					<span class="stage-mark">{s.status === 'done' ? '✔' : s.status === 'active' ? '◉' : '○'}</span>
					<span class="stage-name">{s.name}</span>
					{#if s.ms !== null}<span class="stage-ms">{s.ms}ms</span>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<div class="dlg-title" id="note-title-dialog-heading">{mode === 'create' ? '새 노트' : '제목 수정'}</div>

		<label class="field">
			<span class="field-label">타이틀</span>
			<input bind:this={titleInputEl} bind:value={title} placeholder="제목을 입력하세요" />
		</label>

		{#if mode === 'create'}
			<label class="field">
				<span class="field-label">종류</span>
				<select bind:value={typeId}>
					{#each NOTE_TYPES as t (t.id)}
						<option value={t.id}>{t.label}</option>
					{/each}
				</select>
			</label>
			{#if helpText}
				<p class="help">ℹ {helpText}</p>
			{/if}
		{/if}

		<label class="field">
			<span class="field-label">노트북</span>
			<select bind:value={notebook}>
				<option value={null}>없음</option>
				{#each notebooks as n (n)}
					<option value={n}>🗂 {n}</option>
				{/each}
			</select>
		</label>

		<div class="actions">
			<button class="btn" onclick={oncancel}>취소</button>
			<button class="btn primary" onclick={submit} disabled={!canSubmit}>{confirmLabel}</button>
		</div>
	{/if}
</div>

<style>
	.backdrop {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: var(--z-modal);
	}
	.dialog {
		position: fixed;
		left: 50%; top: 50%;
		transform: translate(-50%, -50%);
		width: min(92vw, 420px);
		background: var(--color-bg, #fff);
		border-radius: 14px;
		padding: 20px;
		z-index: var(--z-modal);
		box-shadow: 0 8px 40px rgba(0, 0, 0, 0.25);
		display: flex; flex-direction: column; gap: 14px;
	}
	.dlg-title { font-size: 1.05rem; font-weight: 700; color: var(--color-text, #111); }
	.field { display: flex; flex-direction: column; gap: 4px; }
	.field-label { font-size: 0.8rem; color: var(--color-text-secondary, #666); }
	.field input, .field select {
		padding: 10px 12px;
		border: 1px solid var(--color-border, #ddd);
		border-radius: 8px;
		font-size: 1rem;
		background: var(--color-bg, #fff);
		color: var(--color-text, #111);
	}
	.help {
		font-size: 0.85rem; line-height: 1.5;
		color: var(--color-text-secondary, #555);
		background: var(--color-bg-secondary, #f5f5f5);
		padding: 10px 12px; border-radius: 8px; margin: 0;
	}
	.actions { display: flex; justify-content: flex-end; gap: 8px; }
	.btn {
		padding: 9px 16px; border: none; border-radius: 8px;
		font-size: 0.95rem; cursor: pointer;
		background: var(--color-bg-secondary, #eee); color: var(--color-text, #111);
	}
	.btn.primary { background: var(--color-primary, #1a73e8); color: #fff; }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.stage { display: flex; align-items: center; gap: 10px; color: var(--color-text-secondary, #888); }
	.stage.active { color: var(--color-text, #111); }
	.stage.done { color: var(--color-text, #111); }
	.stage-mark { width: 18px; text-align: center; }
	.stage-name { flex: 1; }
	.stage-ms { font-size: 0.8rem; color: var(--color-text-secondary, #888); font-variant-numeric: tabular-nums; }
</style>
