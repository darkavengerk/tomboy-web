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
	 *
	 * 표시 모드 두 가지:
	 *  - 모바일(`windowed` 미지정): 풀-스크린(inset:0).
	 *  - 데스크탑(`windowed`): 새 노트 기본 크기(560×520)의 떠다니는 창 — 타이틀바
	 *    드래그 이동 + 8방향 리사이즈. 진짜 데스크탑 윈도우(desktopSession)는 아니라
	 *    세션/지오메트리 영속화는 없다(닫으면 소멸). body 로 portal 해 `.note-window`
	 *    stacking context 밖, `--z-modal` 밴드에 띄운다.
	 */
	import { onMount } from 'svelte';
	import { portal } from '$lib/utils/portal.js';
	import { getAllNotes } from '$lib/storage/noteStore.js';
	import TomboyEditor from '$lib/editor/TomboyEditor.svelte';
	import NoteBundleCabinet from './NoteBundleCabinet.svelte';
	import { buildSyntheticBundleSpec, type BundleSpec } from './index.js';
	import { startPointerDrag, type Geometry } from '$lib/desktop/dragResize.js';
	import ResizeHandles from '$lib/desktop/ResizeHandles.svelte';

	interface Props {
		/** 역참조 대상 노트 제목 — 이 제목을 링크하는 노트들을 모은다. */
		targetTitle: string;
		/** 대상 노트 guid — 자기 자신은 역참조에서 제외. */
		targetGuid: string;
		onclose: () => void;
		/** 활성 역참조 노트 단독 열기(꺼내기). */
		oninternallink: (target: string) => void;
		/** true 면 풀-스크린 대신 드래그/리사이즈 가능한 떠다니는 창(데스크탑). */
		windowed?: boolean;
	}

	let { targetTitle, targetGuid, onclose, oninternallink, windowed = false }: Props = $props();

	// 새 노트 기본 창 크기(desktopSession DEFAULT_WIDTH/HEIGHT 와 동일 값). 합성
	// 오버레이라 세션에 등록하지 않으므로 상수를 그대로 둔다(세션 import 안 함 —
	// 모바일 번들에 데스크탑 세션을 끌어오지 않기 위해).
	const WIN_DEFAULT_WIDTH = 560;
	const WIN_DEFAULT_HEIGHT = 520;
	const WIN_MIN = { width: 280, height: 240 };

	let loading = $state(true);
	let spec = $state<BundleSpec | null>(null);
	let count = $state(0);
	let geo = $state<Geometry>({
		x: 0,
		y: 0,
		width: WIN_DEFAULT_WIDTH,
		height: WIN_DEFAULT_HEIGHT
	});

	const titleDisplay = $derived(targetTitle.trim() || '제목 없음');

	function startTitleDrag(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('[data-no-drag]')) return;
		const origX = geo.x;
		const origY = geo.y;
		startPointerDrag(e, {
			onMove: (dx, dy) => {
				geo = { ...geo, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) };
			}
		});
	}

	onMount(() => {
		// 떠다니는 창은 뷰포트 중앙에서 시작.
		if (windowed && typeof window !== 'undefined') {
			geo = {
				...geo,
				x: Math.max(0, Math.round((window.innerWidth - geo.width) / 2)),
				y: Math.max(0, Math.round((window.innerHeight - geo.height) / 2))
			};
		}
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
<div
	class="bl-overlay"
	class:windowed
	use:portal
	style={windowed
		? `left:${geo.x}px; top:${geo.y}px; width:${geo.width}px; height:${geo.height}px;`
		: ''}
>
	<header class="bl-header" onpointerdown={windowed ? startTitleDrag : undefined}>
		<div class="bl-title">
			<span class="bl-tag">역참조</span>
			<span class="bl-target" title={titleDisplay}>「{titleDisplay}」</span>
			{#if !loading}
				<span class="bl-count">{count}개</span>
			{/if}
		</div>
		<button type="button" class="bl-close" onclick={onclose} aria-label="닫기" data-no-drag>✕</button>
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

	{#if windowed}
		<ResizeHandles base={() => geo} min={WIN_MIN} onresize={(g) => (geo = g)} />
	{/if}
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

	/* 데스크탑 떠다니는 창 — inset 해제하고 inline 지오메트리로 박스. */
	.bl-overlay.windowed {
		inset: auto;
		border: 1px solid var(--color-border, #d4d8dc);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}

	.bl-overlay.windowed .bl-header {
		cursor: grab;
		user-select: none;
		touch-action: none;
		background: var(--color-bg-secondary, #f5f6f7);
	}

	.bl-overlay.windowed .bl-header:active {
		cursor: grabbing;
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
