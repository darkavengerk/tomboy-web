<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { parseRemarkableNote } from '$lib/remarkable/parseRemarkableNote.js';
	import { RM_SLOT_LABELS } from '$lib/remarkable/slots.js';
	import {
		applyWallpaper,
		WallpaperApplyError,
		type WallpaperSlotResult
	} from '$lib/remarkable/applyWallpaper.js';
	import { pushToast } from '$lib/stores/toast.js';

	type Props = {
		editor: Editor;
		bridgeUrl: string;
		bridgeToken: string;
	};
	let { editor, bridgeUrl, bridgeToken }: Props = $props();

	let editorVersion = $state(0);
	$effect(() => {
		// bump 은 $effect 안에서 인라인 정의 — Svelte가 클로저를 올바르게
		// 추적하고, editorVersion 은 $state 라 매 호출 시 최신값을 읽는다.
		const bump = () => (editorVersion = (editorVersion + 1) | 0);
		editor.on('update', bump);
		return () => editor.off('update', bump);
	});

	let spec = $derived.by(() => {
		editorVersion; // 에디터 변경 구독
		return parseRemarkableNote(editor.getJSON());
	});

	type SlotStatus = 'idle' | 'pending' | 'ok' | 'error';
	let statuses = $state<Record<string, SlotStatus>>({});
	let messages = $state<Record<string, string>>({});
	let busy = $state(false);

	function labelFor(slot: string): string {
		return RM_SLOT_LABELS.find((s) => s.slot === slot)?.label ?? slot;
	}

	function icon(status: SlotStatus | undefined): string {
		if (status === 'pending') return '⏳';
		if (status === 'ok') return '✓';
		if (status === 'error') return '✗';
		return '·';
	}

	async function apply() {
		if (!spec || busy || spec.slots.length === 0) return;
		busy = true;
		const pending: Record<string, SlotStatus> = {};
		for (const s of spec.slots) pending[s.slot] = 'pending';
		statuses = pending;
		messages = {};
		try {
			const results: WallpaperSlotResult[] = await applyWallpaper({
				bridgeUrl,
				token: bridgeToken,
				host: spec.host,
				screens: spec.slots
			});
			const nextStatus: Record<string, SlotStatus> = {};
			const nextMsg: Record<string, string> = {};
			for (const r of results) {
				nextStatus[r.slot] = r.status === 'ok' ? 'ok' : 'error';
				if (r.message) nextMsg[r.slot] = r.message;
			}
			statuses = nextStatus;
			messages = nextMsg;
			const ok = results.filter((r) => r.status === 'ok').length;
			pushToast(`배경화면 적용: ${ok}/${results.length} 성공`);
		} catch (err) {
			const msg = err instanceof WallpaperApplyError ? err.message : '적용에 실패했습니다';
			const failed: Record<string, SlotStatus> = {};
			for (const s of spec.slots) failed[s.slot] = 'error';
			statuses = failed;
			messages = {};
			pushToast(msg);
		} finally {
			busy = false;
		}
	}
</script>

{#if spec}
	<div class="rm-bar">
		<div class="rm-head">
			<span class="rm-title">리마커블 배경화면</span>
			<span class="rm-host">{spec.host}</span>
			<button
				class="rm-apply"
				type="button"
				onclick={apply}
				disabled={busy || spec.slots.length === 0}
			>
				{busy ? '적용 중…' : '적용'}
			</button>
		</div>
		{#if spec.slots.length === 0}
			<div class="rm-empty">
				적용할 화면이 없습니다 — 섹션 라벨(예: <code>절전 중:</code>) 아래에 이미지 링크를 넣으세요.
			</div>
		{:else}
			<ul class="rm-slots">
				{#each spec.slots as s (s.slot)}
					<li class="rm-slot" data-status={statuses[s.slot] ?? 'idle'}>
						<span class="rm-icon">{icon(statuses[s.slot])}</span>
						<span class="rm-slot-label">{labelFor(s.slot)}</span>
						{#if messages[s.slot]}<span class="rm-msg">{messages[s.slot]}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.rm-bar {
		border-top: 1px solid var(--border-color, #ddd);
		padding: clamp(6px, 1.5vw, 12px);
		font-size: clamp(0.78rem, 2.4vw, 0.9rem);
		background: var(--bg-subtle, #f6f6f6);
	}
	.rm-head {
		display: flex;
		align-items: center;
		gap: clamp(6px, 1.5vw, 12px);
	}
	.rm-title {
		font-weight: 600;
	}
	.rm-host {
		color: var(--text-muted, #777);
		font-family: monospace;
	}
	.rm-apply {
		margin-left: auto;
		padding: clamp(4px, 1vw, 8px) clamp(10px, 2.5vw, 18px);
		border: 1px solid var(--border-color, #ccc);
		border-radius: 6px;
		background: var(--bg-color, #fff);
		cursor: pointer;
	}
	.rm-apply:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.rm-empty {
		margin-top: 6px;
		color: var(--text-muted, #777);
	}
	.rm-slots {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.rm-slot {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.rm-slot[data-status='ok'] .rm-icon {
		color: #2a7;
	}
	.rm-slot[data-status='error'] .rm-icon {
		color: var(--danger, #c33);
	}
	.rm-msg {
		color: var(--danger, #c33);
		font-size: 0.85em;
	}
</style>
