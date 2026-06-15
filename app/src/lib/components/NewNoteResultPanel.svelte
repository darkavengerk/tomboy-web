<script lang="ts">
	import { portal } from '$lib/utils/portal.js';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';

	// 결과 패널(공용): 생성·제목 변경·수동 "전체 문서 반영" 모두 newNoteFlow 가 구동.
	const s = $derived(newNoteFlow.sweep);
	// While a sweep count/apply is in flight, the panel must NOT be closed out
	// from under the running op (Esc / backdrop / 닫기 are suppressed). The
	// in-flight op exposes 취소, which stops it cleanly via the cancel token.
	const busy = $derived(s.status === 'counting' || s.status === 'applying');

	function closeIfIdle() {
		if (!busy) newNoteFlow.dismiss();
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closeIfIdle();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" use:portal onclick={closeIfIdle}></div>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-note-result-heading" use:portal>
	<div class="dlg-title" id="new-note-result-heading">{newNoteFlow.heading}</div>

	<ul class="stages">
		{#each newNoteFlow.stages as st (st.name)}
			<li class="stage done">
				<span class="stage-mark">✔</span>
				<span class="stage-name">{st.name}</span>
				{#if st.ms !== null}<span class="stage-ms">{st.ms}ms</span>{/if}
			</li>
		{/each}
	</ul>

	{#if s.status === 'idle'}
		<button class="btn" onclick={() => newNoteFlow.startSweepCount()}>전체 문서에 이 제목 반영</button>
	{:else if s.status === 'counting'}
		<p class="info">검색 중… {s.scanned}/{s.total}</p>
		<button class="btn" onclick={() => newNoteFlow.cancelSweep()}>취소</button>
	{:else if s.status === 'confirm'}
		<p class="info">{s.matched}개 노트가 업데이트됩니다.</p>
		<div class="actions">
			<button class="btn" onclick={() => newNoteFlow.cancelSweep()}>취소</button>
			<button class="btn primary" onclick={() => newNoteFlow.applySweep()}>적용</button>
		</div>
	{:else if s.status === 'applying'}
		<p class="info">적용 중… {s.updated}/{s.total}</p>
		<button class="btn" onclick={() => newNoteFlow.cancelSweep()}>취소</button>
	{:else if s.status === 'done'}
		<p class="info">{s.updated}개 완료 ({s.ms}ms){#if s.failed > 0}, {s.failed}개 실패{/if}</p>
	{/if}

	{#if !busy}
		<div class="actions">
			<button class="btn primary" onclick={() => newNoteFlow.dismiss()}>닫기</button>
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
	.stage.done { color: var(--color-text, #111); }
	.stage-mark { width: 18px; text-align: center; }
	.stage-name { flex: 1; }
	.stage-ms { font-size: 0.8rem; color: var(--color-text-secondary, #888); font-variant-numeric: tabular-nums; }
	.info {
		margin: 0;
		font-size: 0.95rem;
		color: var(--color-text-secondary, #555);
	}
</style>
