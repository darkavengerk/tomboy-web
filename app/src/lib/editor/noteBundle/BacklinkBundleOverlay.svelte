<script lang="ts">
	/**
	 * 역참조 → 임시 묶음 노트.
	 *
	 * 어떤 노트의 "역참조"(이 노트를 internal/broken 링크로 가리키는 다른 노트들)를
	 * 풀-스크린 묶음(NoteBundleCabinet) 파일철로 띄운다. 실제 노트가 아니라 합성
	 * BundleSpec(buildSyntheticBundleSpec) — IDB/타이틀 인덱스를 건드리지 않는다.
	 * 임베디드 에디터가 여는 노트들은 진짜이지만(읽기/직접 편집), 묶음 래퍼 자체는
	 * 어디에도 저장되지 않는다(전용 노트와 달리 호스트 노트조차 없다).
	 *
	 * 편집(onraw) 없음 — 편집할 호스트 노트가 없으므로 dchrome 편집 버튼은 숨는다.
	 * 꺼내기(oninternallink)로 활성 역참조 노트를 단독으로 연다.
	 */
	import { onMount } from 'svelte';
	import { portal } from '$lib/utils/portal.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import NoteBundleCabinet from './NoteBundleCabinet.svelte';
	import { buildSyntheticBundleSpec, type BundleSpec } from './index.js';

	interface Props {
		/** 역참조 대상 노트 제목 — 이 제목을 링크하는 노트들을 모은다. */
		targetTitle: string;
		/** 대상 노트 guid — 자기 자신은 역참조에서 제외. */
		targetGuid: string;
		onclose: () => void;
		/** 활성 역참조 노트 단독 열기(꺼내기). */
		oninternallink: (target: string) => void;
	}

	let { targetTitle, targetGuid, onclose, oninternallink }: Props = $props();

	let loading = $state(true);
	let spec = $state<BundleSpec | null>(null);
	let count = $state(0);

	const titleDisplay = $derived(targetTitle.trim() || '제목 없음');

	onMount(() => {
		let cancelled = false;
		(async () => {
			const key = targetTitle.trim();
			const all = await getAllNotes();
			// 기존 역참조 스캔과 동일한 판정(internal + broken). 읽기 전용.
			const titles = all
				.filter((n) => {
					if (n.guid === targetGuid) return false;
					const xml = n.xmlContent;
					return (
						xml.includes(`>${key}</link:internal>`) || xml.includes(`>${key}</link:broken>`)
					);
				})
				.map((n) => n.title.trim())
				.filter(Boolean);
			if (cancelled) return;
			count = titles.length;
			spec = buildSyntheticBundleSpec(titles, 'bundle');
			loading = false;
		})();
		return () => {
			cancelled = true;
		};
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function eject(target: string) {
		onclose();
		oninternallink(target);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="bl-overlay" use:portal>
	<header class="bl-header">
		<div class="bl-title">
			<span class="bl-tag">역참조</span>
			<span class="bl-target" title={titleDisplay}>「{titleDisplay}」</span>
			{#if !loading}
				<span class="bl-count">{count}개</span>
			{/if}
		</div>
		<button type="button" class="bl-close" onclick={onclose} aria-label="닫기">✕</button>
	</header>

	<div class="bl-body">
		{#if loading}
			<p class="bl-msg">역참조를 찾는 중...</p>
		{:else if !spec || count === 0}
			<p class="bl-msg">이 쪽지로 연결된 쪽지가 없습니다.</p>
		{:else}
			<NoteBundleCabinet
				{spec}
				view={null}
				hostGuid={targetGuid}
				variant="dedicated"
				EditorComponent={TomboyEditor}
				oninternallink={eject}
			/>
		{/if}
	</div>
</div>

<style>
	.bl-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		background: var(--color-bg, #fff);
	}

	.bl-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px calc(10px) max(14px, env(safe-area-inset-left));
		border-bottom: 1px solid var(--color-border, #e4e8ec);
		flex-shrink: 0;
	}

	.bl-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.bl-tag {
		flex-shrink: 0;
		font-size: 0.72rem;
		font-weight: 700;
		color: #fff;
		background: var(--color-accent, #4a7);
		border-radius: 4px;
		padding: 2px 6px;
	}

	.bl-target {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text, #111);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bl-count {
		flex-shrink: 0;
		font-size: 0.78rem;
		color: var(--color-text-secondary, #888);
	}

	.bl-close {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		border: none;
		background: none;
		border-radius: 50%;
		font-size: 1rem;
		color: var(--color-text-secondary, #666);
		cursor: pointer;
	}

	.bl-close:active {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.bl-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.bl-msg {
		margin: 0;
		padding: 40px 20px;
		text-align: center;
		color: var(--color-text-secondary, #888);
		font-size: 0.95rem;
	}
</style>
