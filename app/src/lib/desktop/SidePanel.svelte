<script lang="ts">
	import { onMount } from 'svelte';
	import { listNotesShared } from '$lib/core/noteManager.js';
	import { newNoteFlow } from '$lib/stores/newNoteFlow.svelte.js';
	import type { NoteData } from '$lib/core/note.js';
	import { parseTomboyDate } from '$lib/core/note.js';
	import {
		getCachedNotebooks,
		filterByNotebook,
		refreshNotebooksCache,
		assignNotebook
	} from '$lib/core/notebooks.js';
	import { SLIPBOX_NOTEBOOK } from '$lib/sleepnote/validator.js';
	import { createSlipNote } from '$lib/sleepnote/create.js';
	import { searchNotes } from '$lib/search/noteSearch.js';
	import { getCachedNotes, onInvalidate } from '$lib/stores/noteListCache.js';
	import { recentOpens } from './recentOpens.svelte.js';
	import { activeNotebooks } from './activeNotebooks.svelte.js';
	import {
		sidePanelLayout,
		RAIL_MIN_WIDTH,
		RAIL_MAX_WIDTH,
		MAIN_MIN_WIDTH,
		MAIN_MAX_WIDTH
	} from './sidePanelLayout.svelte.js';
	import { startPointerDrag } from './dragResize.js';
	import RailMusicControls from '$lib/editor/musicNote/RailMusicControls.svelte';
	import RailNowPlaying from '$lib/editor/musicNote/RailNowPlaying.svelte';

	// Workspace 1 (top-right of the 2x2 grid) is the dedicated slipnote
	// workspace: entering it auto-selects the [0] Slip-Box notebook and
	// pins the .main panel open so the user can navigate slipnotes
	// without having to hover the rail every time.
	const SLIPNOTE_WORKSPACE_INDEX = 1;

	interface Props {
		openGuids: Set<string>;
		currentWorkspace: number;
		workspaceSummaries: Array<{ index: number; windowCount: number }>;
		/** Current-workspace minimized note guids, most-recently-minimized first. */
		minimizedGuids: string[];
		onopen: (guid: string) => void;
		/** Restore (un-minimize + focus) a minimized note window. */
		onrestore: (guid: string) => void;
		onopensettings: () => void;
		onopenadmin: () => void;
		onswitchworkspace: (index: number) => void;
		onspread: () => void;
		spreadDisabled?: boolean;
	}

	let {
		openGuids,
		currentWorkspace,
		workspaceSummaries,
		minimizedGuids,
		onopen,
		onrestore,
		onopensettings,
		onopenadmin,
		onswitchworkspace,
		onspread,
		spreadDisabled = false
	}: Props = $props();

	let allNotes: NoteData[] = $state(getCachedNotes() ?? []);
	let loading = $state(getCachedNotes() === null);
	let notebooks: string[] = $state([]);
	let query = $state('');

	const filteredNotes = $derived.by(() => {
		const filtered = filterByNotebook(allNotes, displayedNotebook);
		const q = query.trim();
		const base = q ? searchNotes(filtered, q, 200).map((r) => r.note) : filtered;
		// Sort key depends on the workspace:
		// - Slipnote workspace: "recents" by when the user last opened a
		//   note in desktop mode (recentOpens, local-only). Notes without
		//   an open record fall back to changeDate.
		// - All other workspaces: changeDate directly, so the sidebar
		//   mirrors the 전체 page's "최근 수정순" default.
		// Cap at 50 so long histories don't balloon DOM.
		const recents = recentOpens.map;
		const useRecents = currentWorkspace === SLIPNOTE_WORKSPACE_INDEX;
		const keyed = base.map((n) => {
			let key = 0;
			if (useRecents) {
				const opened = recents[n.guid];
				if (opened) {
					key = opened;
				} else {
					const t = parseTomboyDate(n.changeDate).getTime();
					key = Number.isFinite(t) ? t : 0;
				}
			} else {
				const t = parseTomboyDate(n.changeDate).getTime();
				key = Number.isFinite(t) ? t : 0;
			}
			return { n, key };
		});
		keyed.sort((a, b) => b.key - a.key);
		return keyed.slice(0, 50).map((x) => x.n);
	});

	// Minimized note entries (title resolved from the loaded corpus). Order is
	// preserved from minimizedGuids (most-recently-minimized first).
	const minimizedItems = $derived.by(() => {
		const byGuid = new Map(allNotes.map((n) => [n.guid, n.title] as const));
		return minimizedGuids.map((guid) => ({ guid, title: byGuid.get(guid) || '제목 없음' }));
	});

	async function refresh() {
		// Shared read-through cache: warm after any other consumer (title
		// index, slip-note set) has fetched, and patched in place by
		// editor-path saves — so the per-save fan-out below costs zero IDB
		// reads instead of the full-corpus getAll `listNotes()` paid before.
		const fresh = await listNotesShared();
		allNotes = fresh;
		loading = false;
	}

	onMount(() => {
		refresh();
		getCachedNotebooks().then((n) => {
			notebooks = n;
		});
		const off = onInvalidate((kind) => {
			refresh();
			// Single-note patches ('mutate') come from mutation paths that
			// already maintain the notebooks settings-cache themselves
			// (assignNotebook & co. refresh it BEFORE notifying), so a cached
			// read suffices. Bulk invalidates (sync pull, import, …) may have
			// brought notebook template notes the cache has never seen —
			// recompute from the corpus then.
			const notebooksP =
				kind === 'invalidate' ? refreshNotebooksCache() : getCachedNotebooks();
			notebooksP.then((n) => {
				notebooks = n;
			});
		});
		return () => off();
	});

	function handleNew() {
		if (displayedNotebook === SLIPBOX_NOTEBOOK) {
			// 슬립노트는 전용 생성 경로 유지(다이얼로그 미사용).
			void createSlipNote().then((note) => {
				void assignNotebook(note.guid, SLIPBOX_NOTEBOOK);
				onopen(note.guid);
			});
			return;
		}
		// '' (미분류) and null (전체) both mean "no notebook" for a new note.
		const target = displayedNotebook || null;
		newNoteFlow.open({
			notebook: target,
			navigate: (n) => onopen(n.guid)
		});
	}

	const alwaysOpen = $derived(currentWorkspace === SLIPNOTE_WORKSPACE_INDEX);

	// 호버 래치: 마지막으로 호버한 노트북 칩 키(undefined=없음). 칩에서 목록으로
	// 마우스를 옮겨도 패널(aside)을 벗어나기 전까지 유지되어 그 목록의 노트를
	// 클릭할 수 있다. null=전체, ''=미분류, string=노트북. "없음"은 undefined.
	let latched = $state<string | null | undefined>(undefined);

	// .main에 표시할 노트북. 래치가 있으면 그것, 없으면 작업공간 기본값
	// (슬립노트 ws=슬립박스, 그 외=최상단 활성 노트북, 없으면 전체=null).
	const displayedNotebook = $derived(
		latched !== undefined
			? latched
			: alwaysOpen
				? SLIPBOX_NOTEBOOK
				: (activeNotebooks.top(currentWorkspace) ?? null)
	);

	// 고정 스트립에 그릴 활성 노트북(삭제/이름변경된 키는 제외).
	const pinnedNotebooks = $derived(
		activeNotebooks
			.list(currentWorkspace)
			.filter((k) => k === '' || notebooks.includes(k))
	);

	// 작업공간 전환 시 호버 래치 해제: 레일 쿼드런트로 작업공간을 바꾸면
	// 포인터가 aside 안에 머물러 onpointerleave가 안 떠서 이전 작업공간의
	// 래치가 남는다. currentWorkspace만 읽고 latched는 쓰기만 하므로 루프 없음.
	$effect(() => {
		void currentWorkspace;
		latched = undefined;
	});

	let resizingRail = $state(false);
	let resizingMain = $state(false);

	// 고급 메뉴: 자주 안 쓰는 레일 버튼들(그래프/코드 그래프/설정/관리자/
	// 펼쳐보기)을 하나의 토글 뒤로 접어 레일을 가볍게 유지. 플라이아웃은
	// .rail(overflow:hidden) 바깥, aside의 마지막 자식으로 렌더해서 잘리지
	// 않고 .main 위에 그려진다.
	let advancedOpen = $state(false);

	function toggleAdvanced() {
		advancedOpen = !advancedOpen;
	}

	$effect(() => {
		if (!advancedOpen) return;
		const onDocPointer = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			// 토글 버튼이나 메뉴 내부 클릭은 닫지 않음.
			if (t?.closest('.rail-advanced') || t?.closest('.advanced-menu')) return;
			advancedOpen = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') advancedOpen = false;
		};
		window.addEventListener('pointerdown', onDocPointer, true);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onDocPointer, true);
			window.removeEventListener('keydown', onKey);
		};
	});

	function onRailResizeStart(e: PointerEvent) {
		const start = sidePanelLayout.railWidth;
		resizingRail = true;
		startPointerDrag(e, {
			onMove: (dx) => sidePanelLayout.setRailWidth(start + dx),
			onEnd: () => {
				resizingRail = false;
			}
		});
	}

	function onMainResizeStart(e: PointerEvent) {
		const start = sidePanelLayout.mainWidth;
		resizingMain = true;
		startPointerDrag(e, {
			onMove: (dx) => sidePanelLayout.setMainWidth(start + dx),
			onEnd: () => {
				resizingMain = false;
			}
		});
	}
</script>

<aside
	class="side-panel"
	class:always-open={alwaysOpen}
	aria-label="노트 메뉴"
	style="width: {sidePanelLayout.railWidth + sidePanelLayout.mainWidth}px;"
	onpointerleave={() => (latched = undefined)}
>
	<!--
		Rail: always visible, hosts only the workspace switcher. Its width
		defines how much of the canvas is permanently reserved on the right
		(canvas is sized to stop exactly where the rail starts).
	-->
	<div
		class="rail"
		style="flex-basis: {sidePanelLayout.railWidth}px;"
	>
		<div class="workspace-switcher" role="group" aria-label="작업 공간">
			{#each workspaceSummaries as ws (ws.index)}
				<button
					type="button"
					class="quadrant"
					class:active={currentWorkspace === ws.index}
					aria-current={currentWorkspace === ws.index ? 'true' : undefined}
					aria-label={`작업 공간 ${ws.index + 1} — 창 ${ws.windowCount}개`}
					title={`작업 공간 ${ws.index + 1} — 창 ${ws.windowCount}개`}
					onclick={() => onswitchworkspace(ws.index)}
				>
					{#if ws.windowCount > 0}
						<span class="count">{ws.windowCount}</span>
					{/if}
				</button>
			{/each}
		</div>

		<RailMusicControls />

		{#if pinnedNotebooks.length > 0}
			<div class="rail-pinned" role="group" aria-label="고정한 노트북">
				{#each pinnedNotebooks as key (key)}
					<button
						type="button"
						class="rail-chip active"
						class:viewing={displayedNotebook === key}
						title={key === '' ? '미분류' : key}
						onpointerenter={() => (latched = key)}
						onclick={() => activeNotebooks.toggle(currentWorkspace, key)}
					>{key === '' ? '미분류' : key}</button>
				{/each}
			</div>
		{/if}

		<div class="rail-chips" role="tablist" aria-label="노트북 필터">
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:viewing={displayedNotebook === null}
				aria-selected={displayedNotebook === null}
				title="전체"
				onpointerenter={() => (latched = null)}
				onclick={() => activeNotebooks.clear(currentWorkspace)}
			>전체</button>
			<button
				type="button"
				role="tab"
				class="rail-chip"
				class:active={activeNotebooks.isActive(currentWorkspace, '')}
				class:viewing={displayedNotebook === ''}
				aria-selected={displayedNotebook === ''}
				title="미분류"
				onpointerenter={() => (latched = '')}
				onclick={() => activeNotebooks.toggle(currentWorkspace, '')}
			>미분류</button>
			{#each notebooks as nb (nb)}
				<button
					type="button"
					role="tab"
					class="rail-chip"
					class:active={activeNotebooks.isActive(currentWorkspace, nb)}
					class:viewing={displayedNotebook === nb}
					aria-selected={displayedNotebook === nb}
					title={nb}
					onpointerenter={() => (latched = nb)}
					onclick={() => activeNotebooks.toggle(currentWorkspace, nb)}
				>{nb}</button>
			{/each}
		</div>

		<button
			type="button"
			class="rail-settings rail-advanced"
			class:active={advancedOpen}
			onclick={toggleAdvanced}
			aria-haspopup="menu"
			aria-expanded={advancedOpen}
			title="고급"
			aria-label="고급"
		>고급</button>
	</div>

	<!--
		Rail resize handle: 6px-wide grip at the rail's right edge. Drag
		changes the rail's flex-basis (and the canvas's left offset, via
		sidePanelLayout). Sits above .main so it stays grabbable even when
		the panel is collapsed.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resize-handle"
		class:resizing={resizingRail}
		role="separator"
		aria-orientation="vertical"
		aria-label="작업줄 크기 조절"
		aria-valuenow={sidePanelLayout.railWidth}
		aria-valuemin={RAIL_MIN_WIDTH}
		aria-valuemax={RAIL_MAX_WIDTH}
		style="left: {sidePanelLayout.railWidth}px;"
		onpointerdown={onRailResizeStart}
	></div>

	<!--
		Main resize handle: same grip at the .main column's right edge. Drag
		updates mainWidth in sidePanelLayout. Always present (even when
		.main is hover-collapsed) — visible/usable mainly in the slipnote
		workspace where .main is pinned open.
	-->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="resize-handle main-handle"
		class:resizing={resizingMain}
		role="separator"
		aria-orientation="vertical"
		aria-label="확장 영역 크기 조절"
		aria-valuenow={sidePanelLayout.mainWidth}
		aria-valuemin={MAIN_MIN_WIDTH}
		aria-valuemax={MAIN_MAX_WIDTH}
		style="left: {sidePanelLayout.railWidth + sidePanelLayout.mainWidth}px;"
		onpointerdown={onMainResizeStart}
	></div>

	<!--
		Main content: search, new-note, notebook chips, note list, footer.
		Slides off-screen to the right when the panel is not hovered and
		overlays the canvas on hover. Canvas geometry is unaffected.
	-->
	<div class="main" style="flex-basis: {sidePanelLayout.mainWidth}px;">
		<!--
			최소화됨: 확장 영역(.main)의 제일 상단. 최소화된 노트는 캔버스에서
			숨겨지지만 작업공간에는 그대로 남아(F4 펼쳐보기 포함) 여기서 복원한다.
			작업공간별 목록(minimizedGuids는 현재 작업공간 것만).
		-->
		{#if minimizedItems.length > 0}
			<div class="minimized">
				<div class="minimized-label">최소화됨 · {minimizedItems.length}</div>
				<ul>
					{#each minimizedItems as m (m.guid)}
						<li>
							<button
								type="button"
								class="min-item"
								onclick={() => onrestore(m.guid)}
								title={`${m.title} — 복원`}
							>
								<span class="min-glyph" aria-hidden="true">&#x1F5D6;</span>
								<span class="title">{m.title}</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		<div class="header">
			<input
				type="search"
				placeholder="검색"
				bind:value={query}
				aria-label="노트 검색"
			/>
			<button type="button" class="new-btn" onclick={handleNew} title="새 노트">＋ 새 노트</button>
		</div>

		<RailNowPlaying />

		<div class="list">
			{#if loading}
				<div class="empty">로딩 중...</div>
			{:else if filteredNotes.length === 0}
				<div class="empty">노트가 없습니다.</div>
			{:else}
				<ul>
					{#each filteredNotes as n (n.guid)}
						<li>
							<button
								type="button"
								class="note-item"
								class:open={openGuids.has(n.guid)}
								onclick={() => onopen(n.guid)}
								title={n.title}
							>
								<span class="title">{n.title || '제목 없음'}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

	</div>

	<!--
		고급 플라이아웃: .rail 바깥(잘림 방지) + aside의 마지막 자식(.main
		위에 그려짐). 토글이 켜지면 레일 하단 모서리에서 위로 펼쳐진다.
		aside는 pointer-events:none이라 메뉴는 auto로 되살린다.
	-->
	{#if advancedOpen}
		<div class="advanced-menu" role="menu" aria-label="고급">
			<a
				class="adv-item"
				href="/desktop/graph"
				target="_blank"
				rel="noopener"
				role="menuitem"
				title="노트 그래프 (새 탭)"
				onclick={() => (advancedOpen = false)}
			>그래프</a>
			<a
				class="adv-item"
				href="/desktop/codegraph"
				target="_blank"
				rel="noopener"
				role="menuitem"
				title="코드 그래프 (새 탭)"
				onclick={() => (advancedOpen = false)}
			>코드 그래프</a>
			<button
				type="button"
				class="adv-item"
				role="menuitem"
				onclick={() => {
					advancedOpen = false;
					onopensettings();
				}}
			>설정</button>
			<button
				type="button"
				class="adv-item"
				role="menuitem"
				onclick={() => {
					advancedOpen = false;
					onopenadmin();
				}}
			>관리자</button>
			<button
				type="button"
				class="adv-item"
				role="menuitem"
				disabled={spreadDisabled}
				onclick={() => {
					advancedOpen = false;
					onspread();
				}}
			>펼쳐보기 (F4)</button>
		</div>
	{/if}
</aside>

<style>
	.side-panel {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		/* width is set inline so it grows with the user-resizable rail. */
		display: flex;
		flex-direction: row;
		color: #eee;
		z-index: var(--z-nav);
		/* The side-panel box spans the full expanded width so .main can
		   occupy its eventual position when revealed. But we don't want the
		   full box to capture hover — only the visible rail should. Setting
		   pointer-events: none on the container lets child elements opt back
		   in individually; the collapsed .main area passes clicks through to
		   notes beneath. */
		pointer-events: none;
	}

	/* Rail: always-visible left column. Sits flush to the screen's left edge
	   so the shrunk panel remains visible at all times. flex-basis is set
	   inline so the user-resizable width takes effect on every render. */
	.rail {
		flex: 0 0 80px;
		background: #1a1a1a;
		border-right: 1px solid #333;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 10px 0;
		gap: 10px;
		overflow: hidden;
		min-height: 0;
		pointer-events: auto;
	}

	/* Vertical drag grip at the rail's right edge. 6px hit target with a
	   1px visible line so it doesn't fight the rail border for attention. */
	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		margin-left: -2px;
		cursor: ew-resize;
		pointer-events: auto;
		z-index: 1;
		background: transparent;
		transition: background 120ms ease;
	}

	.resize-handle:hover,
	.resize-handle.resizing {
		background: rgba(90, 153, 255, 0.35);
	}

	/* Main handle sits at .main's right edge — for default widths that's
	   ~300px from the screen edge, well inside the canvas. If it captured
	   pointer events while .main is collapsed, the user brushing this
	   invisible 6px strip during unrelated work would trigger
	   .side-panel:hover and pop the panel open from nowhere. Gate it on
	   the panel actually being expanded (rail hover, focus inside .main,
	   slipnote always-open) or an in-progress drag. The rail handle is
	   adjacent to the visible rail and intentionally stays auto. */
	.resize-handle.main-handle {
		pointer-events: none;
	}
	.side-panel:hover .resize-handle.main-handle,
	.side-panel:has(.main:focus-within) .resize-handle.main-handle,
	.side-panel.always-open .resize-handle.main-handle,
	.resize-handle.main-handle.resizing {
		pointer-events: auto;
	}

	.rail-chips {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		width: 100%;
		padding: 0 6px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.rail-chip {
		padding: 5px 6px;
		border-radius: 4px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #bbb;
		font-size: 0.7rem;
		cursor: pointer;
		text-align: center;
		line-height: 1.2;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.rail-chip:hover {
		background: #232323;
		color: #fff;
	}

	.rail-chip.active {
		background: #2d5a3d;
		color: #fff;
		border-color: #3a7a50;
	}

	/* 고정 스트립: 음악 컨트롤 밑, 노트북 칩 위. 같은 칩 스타일 재사용. */
	.rail-pinned {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		width: 100%;
		padding: 0 6px;
		flex-shrink: 0;
	}

	/* 현재 .main에 표시 중인 노트북 칩 강조(고정=녹색 배경과 구분되는 청록 테두리). */
	.rail-chip.viewing {
		border-color: #5a9;
		box-shadow: inset 0 0 0 1px #5a9;
	}

	/* Main: revealed column to the right of the rail. When collapsed it is
	   clipped away (not translated), so expanding reveals the hidden content
	   growing out from behind the rail rather than sliding in as a block.
	   flex-basis is set inline so the user-resizable width takes effect on
	   every render. */
	.main {
		flex: 0 0 220px;
		min-width: 0;
		background: #1a1a1a;
		border-right: 1px solid #333;
		display: flex;
		flex-direction: column;
		clip-path: inset(0 100% 0 0);
		pointer-events: none;
		transition: clip-path 180ms ease;
	}

	/* Reveal triggers: hovering ANY part of the side-panel (rail, either
	   resize handle, or .main itself), or keyboard focus inside .main. The
	   side-panel container has pointer-events: none, but :hover still
	   propagates up from descendants whose pointer-events are auto, so this
	   rule activates as soon as the mouse enters any interactive child and
	   stays activated as it traverses between them — including across the
	   resize handle that sits between rail and main. We deliberately do
	   NOT match focus-within on the whole side-panel; chip /
	   workspace-quadrant clicks in the rail would otherwise latch the
	   panel open after the mouse leaves. */
	.side-panel:hover .main,
	.main:focus-within,
	.side-panel.always-open .main {
		clip-path: inset(0 0 0 0);
		pointer-events: auto;
	}

	/* In the slipnote workspace .main is pinned open, so its drag transition
	   would feel laggy when entering/leaving. Drop the transition here. */
	.side-panel.always-open .main {
		transition: none;
	}

	.header {
		padding: 12px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-bottom: 1px solid #2a2a2a;
		flex-shrink: 0;
	}

	.header input {
		width: 100%;
		padding: 6px 10px;
		border-radius: 4px;
		border: 1px solid #333;
		background: #111;
		color: #eee;
		font-size: 0.85rem;
		outline: none;
	}

	.header input:focus {
		border-color: #5a9;
	}

	.new-btn {
		padding: 6px 10px;
		background: #2d5a3d;
		color: #eee;
		border: 1px solid #3a7a50;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
	}

	.new-btn:hover {
		background: #3a7a50;
	}

	.workspace-switcher {
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
		gap: 4px;
		width: calc(100% - 12px);
		aspect-ratio: 1 / 1;
		padding: 4px;
		background: #111;
		border: 1px solid #333;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.quadrant {
		position: relative;
		padding: 0;
		background: #1f1f1f;
		border: 1px solid #2a2a2a;
		border-radius: 2px;
		cursor: pointer;
		color: #888;
		font-size: 0.8rem;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.quadrant:hover {
		background: #2a2a2a;
		border-color: #3a7a50;
	}

	.quadrant.active {
		background: #2d5a3d;
		border-color: #5ab378;
		color: #fff;
	}

	.quadrant .count {
		font-weight: 600;
	}

	.list {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.list ul {
		list-style: none;
		padding: 4px 0;
		margin: 0;
	}

	.note-item {
		display: block;
		width: 100%;
		padding: 7px 12px;
		background: transparent;
		border: none;
		border-right: 3px solid transparent;
		color: #ddd;
		text-align: left;
		cursor: pointer;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note-item:hover {
		background: #232323;
	}

	.note-item.open {
		border-right-color: #5a9;
		background: #1f1f1f;
		font-weight: 600;
		color: #fff;
	}

	.title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty {
		padding: 24px 12px;
		text-align: center;
		color: #888;
		font-size: 0.85rem;
	}

	/* 최소화됨 섹션: .main 최상단(헤더 위). 너무 길어지지 않게 자체 스크롤. */
	.minimized {
		flex-shrink: 0;
		max-height: 40%;
		overflow-y: auto;
		border-bottom: 1px solid #2a2a2a;
		background: #161616;
	}

	.minimized-label {
		padding: 8px 12px 4px;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: #888;
	}

	.minimized ul {
		list-style: none;
		padding: 0 0 4px;
		margin: 0;
	}

	.min-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 12px;
		background: transparent;
		border: none;
		border-right: 3px solid transparent;
		color: #ccc;
		text-align: left;
		cursor: pointer;
		font-size: 0.82rem;
		overflow: hidden;
	}

	.min-item:hover {
		background: #232323;
		color: #fff;
		border-right-color: #5a9;
	}

	.min-glyph {
		flex-shrink: 0;
		font-size: 0.8rem;
		opacity: 0.6;
	}

	/* Settings lives in the rail so it stays visible when the panel is
	   collapsed. It is outside the scrollable .rail-chips column on purpose:
	   the chips scroll independently while this button stays pinned at the
	   bottom of the rail. */
	.rail-settings {
		flex-shrink: 0;
		margin-top: auto;
		width: calc(100% - 12px);
		padding: 6px 4px;
		border-radius: 4px;
		border: 1px solid #2a2a2a;
		background: #111;
		color: #bbb;
		font-size: 0.7rem;
		cursor: pointer;
		text-align: center;
		line-height: 1.2;
	}

	.rail-settings:hover {
		background: #232323;
		color: #fff;
	}

	.rail-settings:disabled {
		opacity: 0.4;
		cursor: default;
		pointer-events: none;
	}

	/* 고급 토글: 레일 맨 아래에 핀(rail-settings의 margin-top:auto 상속).
	   열려 있으면 활성 색으로 표시. */
	.rail-advanced.active {
		background: #2d5a3d;
		color: #fff;
		border-color: #3a7a50;
	}

	/* 고급 플라이아웃 메뉴: 레일 하단 모서리에서 위로 펼쳐지는 세로 목록.
	   aside(pointer-events:none) 안이라 auto로 되살리고, 레일보다 넓게
	   띄워 레이블이 한 줄에 들어오게 한다. */
	.advanced-menu {
		position: absolute;
		left: 6px;
		bottom: 44px;
		width: 150px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px;
		background: #1f1f1f;
		border: 1px solid #3a3a3a;
		border-radius: 6px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
		pointer-events: auto;
	}

	.adv-item {
		display: block;
		width: 100%;
		padding: 7px 10px;
		border-radius: 4px;
		border: 1px solid transparent;
		background: transparent;
		color: #ddd;
		font-size: 0.8rem;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		line-height: 1.2;
	}

	.adv-item:hover {
		background: #2a2a2a;
		color: #fff;
	}

	.adv-item:disabled {
		opacity: 0.4;
		cursor: default;
		pointer-events: none;
	}
</style>
