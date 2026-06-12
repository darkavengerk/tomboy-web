<script lang="ts">
	/**
	 * 노트 묶음 스택 — 5칸 타이틀 윈도우(활성 노트 위·아래로 접힌 바) +
	 * 펼친 노트(임베디드 TomboyEditor).
	 *
	 * noteBundlePlugin 의 위젯 컨테이너(외부 에디터의 contenteditable=false
	 * 섬) 안에 mount() 된다. 루트에서 입력/클립보드/포인터 이벤트를
	 * stopPropagation — 외부 PM 이 임베디드 에디터 이벤트를 보지 못하게
	 * 하는 editor-in-editor 격벽.
	 *
	 * spec 은 전체 교체 계약 (StackController.update 참고) — ordinal 재배정
	 * 으로 다른 번들의 spec 을 받을 수 있으므로 모든 상태는 현재 spec 에서
	 * 파생한다. EditorComponent 는 TomboyEditor 자신 (셀프 임포트 주입) —
	 * 이 파일이 직접 임포트하면 순환이 생기므로 prop 으로 받는다.
	 */
	import { onMount, onDestroy, untrack } from 'svelte';
	import { flip } from 'svelte/animate';
	import type { Component } from 'svelte';
	import type { EditorView } from '@tiptap/pm/view';
	import type { JSONContent } from '@tiptap/core';
	import type { BundleSpec } from './parser.js';
	import { selectBundleEntry, writeBundleHeightPct } from './noteBundlePlugin.js';
	import {
		windowWidth,
		clampWindow,
		stepWindow,
		initialWindow,
		firstValidIndex,
		nextValidIndex
	} from './stackMath.js';
	import { lookupGuidByTitle, ensureTitleIndexReady } from '../autoLink/titleProvider.js';
	import {
		getNote,
		getNoteEditorContent,
		updateNoteFromEditor
	} from '$lib/core/noteManager.js';
	import { subscribeNoteReload, subscribeNoteFlush } from '$lib/core/noteReloadBus.js';
	import { attachOpenNote, detachOpenNote } from '$lib/sync/firebase/orchestrator.js';

	interface Props {
		spec: BundleSpec;
		view: EditorView;
		hostGuid: string | null;
		// Component<any>: svelte-check 가 실제 TomboyEditor props 와 대조할 때
		// Record<string,unknown> 이 enableNoteBundle 등 선택적 prop 와 충돌하면
		// any 로 완화한다 (Task 4 에서 실제 타입 확인).
		EditorComponent: Component<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
		oninternallink?: (target: string) => void;
	}
	let { spec, view, hostGuid, EditorComponent, oninternallink }: Props = $props();

	// --- guid 해석 ----------------------------------------------------------
	let titleEpoch = $state(0);
	onMount(() => {
		void ensureTitleIndexReady().then(() => {
			titleEpoch++;
		});
	});

	interface ResolvedEntry {
		title: string;
		guid: string | null;
		broken: boolean;
		/** spec.entries 인덱스 — selectBundleEntry 용 */
		originalIndex: number;
		selected: boolean;
	}
	const resolved = $derived.by<ResolvedEntry[]>(() => {
		void titleEpoch;
		const out: ResolvedEntry[] = [];
		spec.entries.forEach((e, i) => {
			const guid = lookupGuidByTitle(e.title);
			if (guid !== null && guid === hostGuid) return; // 자기참조 제외
			out.push({
				title: e.title,
				guid,
				broken: guid === null,
				originalIndex: i,
				selected: e.selected
			});
		});
		return out;
	});

	// 펼침 인덱스(resolved 기준): 라디오 선택 우선, 없으면 첫 유효 항목
	const k = $derived.by(() => {
		const sel = resolved.findIndex((e) => e.selected && !e.broken);
		if (sel >= 0) return sel;
		return firstValidIndex(resolved);
	});
	const expanded = $derived(k >= 0 ? resolved[k] : null);

	// --- 타이틀 윈도우 ---------------------------------------------------------
	// winStart 는 컴포넌트 로컬 — 영속 안 함 (라디오=활성만 영속).
	let winStart = $state(0);
	let winInit = false;
	let lastK = -1;
	/** step() 이 기록한 직전 이동 방향 — follow effect 가 1회 소비 */
	let pendingDir: 1 | -1 | null = null;

	// k(활성)·N 변화를 따라 윈도우를 이동. winStart 를 읽고 쓰므로 untrack 필수
	// (effect_update_depth 함정).
	$effect(() => {
		const n = resolved.length;
		const kk = k;
		untrack(() => {
			const dir = pendingDir;
			pendingDir = null;
			if (kk < 0) {
				lastK = kk;
				winInit = false;
				return;
			}
			if (!winInit) {
				winStart = initialWindow(kk, n);
				winInit = true;
			} else if (kk !== lastK && dir !== null) {
				winStart = stepWindow(winStart, kk, dir, n);
			} else {
				winStart = clampWindow(winStart, kk, n);
			}
			lastK = kk;
		});
	});

	const W = $derived(windowWidth(resolved.length));
	const winEntries = $derived(resolved.slice(winStart, winStart + W));
	const hiddenAbove = $derived(winStart);
	const hiddenBelow = $derived(Math.max(0, resolved.length - (winStart + W)));

	// --- 높이 ----------------------------------------------------------------
	let rootEl = $state<HTMLElement | null>(null);
	let hostH = $state(600);
	let dragPx = $state<number | null>(null);
	const stackH = $derived(dragPx ?? Math.max(140, Math.round((hostH * spec.heightPct) / 100)));

	onMount(() => {
		const hostEl = view.dom.closest<HTMLElement>('.tomboy-editor') ?? view.dom.parentElement;
		if (!hostEl) return;
		hostH = hostEl.clientHeight || 600;
		const ro = new ResizeObserver(() => {
			hostH = hostEl.clientHeight || hostH;
		});
		ro.observe(hostEl);
		return () => ro.disconnect();
	});

	// --- 이벤트 격벽 -----------------------------------------------------------
	const ISOLATED_EVENTS = [
		'keydown',
		'keyup',
		'keypress',
		'beforeinput',
		'input',
		'compositionstart',
		'compositionupdate',
		'compositionend',
		'paste',
		'copy',
		'cut',
		'pointerdown',
		'mousedown',
		'click',
		'touchstart',
		'dragstart',
		'dragover',
		'drop'
	] as const;
	onMount(() => {
		const el = rootEl;
		if (!el) return;
		const stop = (e: Event) => e.stopPropagation();
		// Ctrl/Cmd+Home/End 의 네이티브 동작은 "editing host 의 처음/끝으로
		// 캐럿 이동"인데, 크롬은 중첩 편집 섬에서 바깥 에디터를 호스트로
		// 보고 캐럿을 탈출시킨다 → 이후 타이핑이 호스트 노트를 오염.
		// stopPropagation 으로는 못 막으므로 이 둘만 기본 동작을 차단한다.
		const stopKeydown = (e: Event) => {
			const ke = e as KeyboardEvent;
			if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'Home' || ke.key === 'End')) {
				ke.preventDefault();
			}
			ke.stopPropagation();
		};
		const pairs: Array<[string, (e: Event) => void]> = ISOLATED_EVENTS.map(
			(t) => [t, t === 'keydown' ? stopKeydown : stop]
		);
		for (const [t, h] of pairs) el.addEventListener(t, h);
		return () => {
			for (const [t, h] of pairs) el.removeEventListener(t, h);
		};
	});

	// --- 펼침 노트 로드/저장 (NoteWindow 패턴 축소판) ----------------------------
	let editorContent = $state.raw<JSONContent | null>(null);
	let loadedGuid = $state<string | null>(null);
	let createDate = $state<string | null>(null);
	let pendingDoc: JSONContent | null = null;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let loadEpoch = 0;
	let offReload: (() => void) | null = null;
	let offFlush: (() => void) | null = null;

	async function flushSave(): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		const docJson = pendingDoc;
		const guid = loadedGuid;
		pendingDoc = null;
		if (!docJson || !guid) return;
		try {
			await updateNoteFromEditor(guid, docJson);
		} catch (err) {
			console.error('[noteBundle flushSave]', err);
		}
	}

	function handleEmbeddedChange(doc: JSONContent) {
		pendingDoc = doc;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void flushSave();
		}, 1500);
	}

	async function loadExpanded(guid: string) {
		const epoch = ++loadEpoch;
		await flushSave();
		if (epoch !== loadEpoch) return;
		if (loadedGuid && loadedGuid !== guid) {
			detachOpenNote(loadedGuid);
			offReload?.();
			offReload = null;
			offFlush?.();
			offFlush = null;
		}
		const note = await getNote(guid);
		if (epoch !== loadEpoch) return;
		if (!note) {
			editorContent = null;
			loadedGuid = null;
			return;
		}
		editorContent = getNoteEditorContent(note);
		createDate = note.createDate ?? null;
		loadedGuid = guid;
		attachOpenNote(guid);
		offReload = subscribeNoteReload(guid, async () => {
			// 렌임 스윕 등 외부 rewrite — pending 폐기 후 IDB 재로드
			if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
			pendingDoc = null;
			const fresh = await getNote(guid);
			if (fresh && loadedGuid === guid) editorContent = getNoteEditorContent(fresh);
		});
		offFlush = subscribeNoteFlush(guid, () => flushSave());
	}

	$effect(() => {
		const g = expanded?.guid ?? null;
		if (g && g !== loadedGuid) void loadExpanded(g);
	});

	onDestroy(() => {
		void flushSave();
		if (loadedGuid) detachOpenNote(loadedGuid);
		offReload?.();
		offFlush?.();
	});

	/** Svelte 5 는 click/pointer* 를 document 루트 위임으로 처리하는데, 루트
	 *  격벽의 stopPropagation 이 위임 핸들러 도달을 막는다 — 스택 내부
	 *  인터랙션은 전부 이 액션으로 직접 addEventListener 한다. */
	function direct(node: HTMLElement, handlers: Record<string, (e: Event) => void>) {
		const entries = Object.entries(handlers);
		for (const [t, h] of entries) node.addEventListener(t, h);
		return {
			destroy() {
				for (const [t, h] of entries) node.removeEventListener(t, h);
			}
		};
	}

	// --- 전환 (휠 / 스와이프 / 바 클릭) ------------------------------------------
	function moveTo(target: number) {
		if (target < 0 || target >= resolved.length || target === k) return;
		const entry = resolved[target];
		if (entry.broken) return;
		selectBundleEntry(view, spec.ordinal, entry.originalIndex);
	}
	function step(dir: 1 | -1) {
		if (k < 0) return;
		const target = nextValidIndex(resolved, k, dir);
		if (target === k) return;
		pendingDir = dir;
		moveTo(target);
	}

	let wheelAcc = 0;
	function flipWheel(e: WheelEvent) {
		e.preventDefault(); // ctrl+wheel 브라우저 줌 차단 겸용
		e.stopPropagation();
		wheelAcc += e.deltaY;
		while (wheelAcc >= 50) {
			step(1);
			wheelAcc -= 50;
		}
		while (wheelAcc <= -50) {
			step(-1);
			wheelAcc += 50;
		}
		wheelAcc = Math.max(-49, Math.min(49, wheelAcc));
	}
	function handleListWheel(e: Event) {
		const we = e as WheelEvent;
		if (we.ctrlKey || we.metaKey) {
			flipWheel(we);
			return;
		}
		// 콘텐츠 위 일반 wheel = 임베디드 스크롤 그대로
		if ((we.target as HTMLElement).closest?.('.bundle-body')) return;
		flipWheel(we);
	}
	/** 루트 폴백 — 리사이즈 핸들 등 .bundle-list 밖에서의 ctrl+wheel.
	 *  바/콘텐츠 위 ctrl+wheel 은 handleListWheel 이 stopPropagation 으로 선점. */
	function handleRootWheel(e: Event) {
		const we = e as WheelEvent;
		if (we.ctrlKey || we.metaKey) flipWheel(we);
	}

	let swipeY: number | null = null;
	let downBarIdx: number | null = null;
	let downBarY = 0;
	let swiped = false;
	let lastTapIdx: number | null = null;
	let lastTapTime = 0;

	function handleListPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		if (t.closest?.('.bundle-body')) return; // 임베디드 에디터 — 손대지 않음
		const bar = t.closest?.('.bundle-bar') as HTMLElement | null;
		if (!bar) return;
		swipeY = e.clientY;
		downBarY = e.clientY;
		swiped = false;
		downBarIdx = bar.dataset.idx != null ? Number(bar.dataset.idx) : null;
		try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
	}
	function handleListPointerMove(e: PointerEvent) {
		if (swipeY === null) return;
		const dy = e.clientY - swipeY;
		if (Math.abs(dy) >= 30) {
			swiped = true;
			step(dy < 0 ? 1 : -1); // 위로 끌면 다음 파일철
			swipeY = e.clientY;
		}
	}
	function handleListPointerUp(e: Event) {
		const pe = e as PointerEvent;
		// 캡처가 click 을 컨테이너로 retarget 하므로 click/dblclick 대신
		// pointerup 에서 탭·더블탭을 수동 판정한다.
		if (!swiped && downBarIdx !== null && Math.abs(pe.clientY - downBarY) < 8) {
			const now = performance.now();
			if (lastTapIdx === downBarIdx && now - lastTapTime < 300) {
				const entry = resolved[downBarIdx];
				if (entry && !entry.broken) oninternallink?.(entry.title);
				lastTapIdx = null;
			} else {
				moveTo(downBarIdx);
				lastTapIdx = downBarIdx;
				lastTapTime = now;
			}
		}
		swipeY = null;
		downBarIdx = null;
	}

	// --- 하단 리사이즈 핸들 -------------------------------------------------------
	let resizeStartY = 0;
	let resizeStartH = 0;
	function handleResizeDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		resizeStartY = e.clientY;
		resizeStartH = stackH;
		dragPx = stackH;
		try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
	}
	function handleResizeMove(e: PointerEvent) {
		if (dragPx === null) return;
		dragPx = Math.max(140, resizeStartH + (e.clientY - resizeStartY));
	}
	function handleResizeUp() {
		if (dragPx === null) return;
		const pct = Math.round((dragPx / Math.max(1, hostH)) * 100);
		dragPx = null;
		writeBundleHeightPct(view, spec.ordinal, pct);
	}
</script>

<div class="bundle-stack" bind:this={rootEl} style:height={`${stackH}px`} use:direct={{ wheel: handleRootWheel }}>
	{#if resolved.length === 0}
		<div class="bundle-empty">묶을 노트 없음</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="bundle-list"
			use:direct={{
				wheel: handleListWheel,
				pointerdown: handleListPointerDown as (e: Event) => void,
				pointermove: handleListPointerMove as (e: Event) => void,
				pointerup: handleListPointerUp,
				pointercancel: handleListPointerUp
			}}
		>
			{#each winEntries as e, i (e.originalIndex)}
				<!-- animate:flip 은 keyed each 직계 자식이어야 한다 → 활성도 button 으로 통일 -->
				<button
					type="button"
					class="bundle-bar"
					class:broken={e.broken}
					class:expanded-bar={winStart + i === k}
					data-idx={winStart + i}
					style:order={i * 2}
					animate:flip={{ duration: 150 }}
				>
					<span class="bar-title">{e.title}</span>
					{#if i === 0 && hiddenAbove > 0}
						<span class="bar-badge">+{hiddenAbove}</span>
					{:else if i === winEntries.length - 1 && hiddenBelow > 0}
						<span class="bar-badge">+{hiddenBelow}</span>
					{/if}
				</button>
			{/each}
			{#if expanded && editorContent && loadedGuid}
				<div class="bundle-body" style:order={(k - winStart) * 2 + 1}>
					<EditorComponent
						content={editorContent}
						currentGuid={loadedGuid}
						onchange={handleEmbeddedChange}
						oninternallink={(t: string) => oninternallink?.(t)}
						enableNoteBundle={false}
						hrSplitEnabled={false}
						{createDate}
					/>
				</div>
			{:else if expanded}
				<div class="bundle-empty" style:order={(k - winStart) * 2 + 1}>로딩…</div>
			{:else}
				<div class="bundle-empty">펼칠 수 있는 노트 없음</div>
			{/if}
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="bundle-resize"
		use:direct={{
			pointerdown: handleResizeDown as (e: Event) => void,
			pointermove: handleResizeMove as (e: Event) => void,
			pointerup: handleResizeUp,
			pointercancel: handleResizeUp
		}}
		aria-hidden="true"
	></div>
</div>

<style>
	.bundle-stack {
		display: flex;
		flex-direction: column;
		margin: 8px 0;
		border: 1px solid #444;
		border-radius: 6px;
		overflow: hidden;
		background: #1e1e1e;
	}
	.bundle-list {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	/* NoteWindow .title-bar 시각 언어 재사용 (dark #2a2a2a / focused green) */
	.bundle-bar {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		border: none;
		border-bottom: 1px solid #1a1a1a;
		padding: clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px);
		background: #2a2a2a;
		color: #eee;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		touch-action: none; /* 바에서 시작한 스와이프가 pointercancel 로 죽지 않게 */
		user-select: none;
	}
	.bar-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.bar-badge {
		flex-shrink: 0;
		color: #999;
		font-size: 0.75rem;
	}
	.bundle-bar.broken {
		color: #777;
		cursor: default;
	}
	.bundle-bar.expanded-bar {
		background: #2d5a3d;
		cursor: grab;
	}
	.bundle-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--color-bg, #fff);
	}
	.bundle-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #888;
		font-size: 0.85rem;
	}
	.bundle-resize {
		flex-shrink: 0;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
		background: #2a2a2a;
	}
	.bundle-resize::after {
		content: '';
		display: block;
		width: 36px;
		height: 3px;
		border-radius: 2px;
		margin: 2.5px auto;
		background: #555;
	}
</style>
