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
	 *
	 * ── 열린 노트 유지 + 서랍 애니메이션 ──────────────────────────────
	 * 한 번이라도 펼친 노트는 에디터 세션(sessions)을 살려 둔다(lazy mount,
	 * 언마운트 없음). 모든 항목이 "바 + 자기 본문" 쌍으로 DOM 순서 그대로
	 * 놓이고, 활성 본문만 flex-grow:1 — 전환은 flex-grow CSS transition 으로
	 * 옛 본문이 접히고 새 본문이 펼쳐지는 서랍 모션이 레이아웃 자체에서
	 * 일어난다. 바들은 매 프레임 레이아웃을 따라 움직이므로 별도 FLIP 불요.
	 * 이전 단일-body 구조는 본문이 바를 덮어 그려 이동 애니메이션이 가려졌고,
	 * 들어올 본문이 스텝 시점에 존재하지 않아(IDB async 로드) 교체 자체에
	 * 애니메이션을 걸 수 없었다.
	 *
	 * 윈도우 밖 바는 제거 대신 .off(max-height 0 + 우측 48px + 투명)로
	 * 접는다 — 클래스 토글이 CSS transition 을 타므로 윈도우에서 밀려나는
	 * 바가 오른쪽 +N 배지로 빨려 들어가듯 사라지고, 들어오는 바는 역재생.
	 */
	import { onMount, onDestroy, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
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
	const hiddenAbove = $derived(winStart);
	const hiddenBelow = $derived(Math.max(0, resolved.length - (winStart + W)));
	const lastVisibleIdx = $derived(Math.min(winStart + W, resolved.length) - 1);

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
		//
		// 화살표/Page 키도 같은 계열: 임베디드 문서의 첫/끝 줄에서 ↑/↓ 가
		// 경계를 넘어 호스트 editable 로 캐럿을 탈출시킨다. 이들은 줄 내
		// 이동에 필요해서 preventDefault 로 일괄 차단할 수 없다 — 이동 후
		// 탈출이 감지되면 키 이전 위치로 복원한다.
		const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);
		const guardCaretEscape = () => {
			const sel = document.getSelection();
			if (!sel || sel.rangeCount === 0) return;
			const before = sel.getRangeAt(0).cloneRange();
			setTimeout(() => {
				const s = document.getSelection();
				const n = s?.anchorNode;
				const anchorEl = n ? (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement) : null;
				if (!anchorEl || rootEl?.contains(anchorEl)) return; // 섬 안 — 정상 이동
				// 탈출 → 임베디드 에디터로 포커스 + 캐럿 원위치.
				// 스냅샷 컨테이너가 동시 PM 트랜잭션으로 분리됐으면 기존 선택을
				// 지우지 않고 포기 (removeAllRanges 후 addRange 실패 = 무선택 상태).
				const bc = before.startContainer;
				if (!bc.isConnected) return;
				try {
					const bcEl = bc.nodeType === Node.ELEMENT_NODE ? (bc as Element) : bc.parentElement;
					bcEl?.closest<HTMLElement>('.ProseMirror')?.focus({ preventScroll: true });
					s?.removeAllRanges();
					s?.addRange(before);
				} catch {
					/* 스냅샷 무효화 (IndexSizeError 등) — 복원 포기 */
				}
			}, 0);
		};
		const stopKeydown = (e: Event) => {
			const ke = e as KeyboardEvent;
			if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'Home' || ke.key === 'End')) {
				ke.preventDefault();
			}
			if (NAV_KEYS.has(ke.key)) guardCaretEscape();
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

	// --- 에디터 세션 (노트별, lazy mount 후 유지) -------------------------------
	// 처음 펼칠 때 IDB 로드 + attach + 구독을 만들고, 스택이 살아 있는 동안
	// 유지한다. 스텝마다 로드/저장이 인터리브되던 단일-body 구조의 flushSave
	// 레이스가 사라지고, 노트별 커서·언두가 보존되며, 전환 애니메이션이
	// 이미 마운트된 본문 사이에서 일어난다.
	interface EditorSession {
		guid: string;
		content: JSONContent;
		createDate: string | null;
		pendingDoc: JSONContent | null;
		saveTimer: ReturnType<typeof setTimeout> | null;
		offReload: () => void;
		offFlush: () => void;
	}
	const sessions = new SvelteMap<string, EditorSession>();
	const loading = new Set<string>();
	let destroyed = false;

	async function flushSession(guid: string): Promise<void> {
		const s = sessions.get(guid);
		if (!s) return;
		if (s.saveTimer) {
			clearTimeout(s.saveTimer);
			s.saveTimer = null;
		}
		const docJson = s.pendingDoc;
		s.pendingDoc = null;
		if (!docJson) return;
		try {
			await updateNoteFromEditor(guid, docJson);
		} catch (err) {
			console.error('[noteBundle flushSave]', err);
		}
	}

	function handleEmbeddedChange(guid: string, doc: JSONContent) {
		const s = sessions.get(guid);
		if (!s) return;
		s.pendingDoc = doc;
		if (s.saveTimer) clearTimeout(s.saveTimer);
		s.saveTimer = setTimeout(() => {
			void flushSession(guid);
		}, 1500);
	}

	async function loadSession(guid: string) {
		if (sessions.has(guid) || loading.has(guid)) return;
		loading.add(guid);
		try {
			const note = await getNote(guid);
			if (!note || destroyed || sessions.has(guid)) return;
			attachOpenNote(guid);
			const offReload = subscribeNoteReload(guid, async () => {
				// 렌임 스윕 등 외부 rewrite — pending 폐기 후 IDB 재로드
				const cur = sessions.get(guid);
				if (cur) {
					if (cur.saveTimer) {
						clearTimeout(cur.saveTimer);
						cur.saveTimer = null;
					}
					cur.pendingDoc = null;
				}
				const fresh = await getNote(guid);
				const live = sessions.get(guid);
				if (fresh && live) sessions.set(guid, { ...live, content: getNoteEditorContent(fresh) });
			});
			const offFlush = subscribeNoteFlush(guid, () => flushSession(guid));
			sessions.set(guid, {
				guid,
				content: getNoteEditorContent(note),
				createDate: note.createDate ?? null,
				pendingDoc: null,
				saveTimer: null,
				offReload,
				offFlush
			});
		} finally {
			loading.delete(guid);
		}
	}

	function teardownSession(guid: string) {
		const s = sessions.get(guid);
		if (!s) return;
		void flushSession(guid);
		detachOpenNote(guid);
		s.offReload();
		s.offFlush();
		sessions.delete(guid);
	}

	// 활성 노트 세션 보장
	$effect(() => {
		const g = expanded?.guid ?? null;
		if (g && !sessions.has(g)) void loadSession(g);
	});

	// spec 에서 빠진 노트 세션 정리 (사용자가 목록을 편집한 경우).
	// sessions 를 읽고 쓰므로 untrack — resolved 변화에만 반응.
	$effect(() => {
		const valid = new Set(resolved.map((e) => e.guid).filter((g): g is string => g !== null));
		untrack(() => {
			for (const guid of [...sessions.keys()]) {
				if (!valid.has(guid)) teardownSession(guid);
			}
		});
	});

	onDestroy(() => {
		destroyed = true;
		for (const guid of [...sessions.keys()]) teardownSession(guid);
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
		// 방향 반전 시 잔여 폐기 — 반대 방향 첫 응답이 굼뜨지 않게
		if (Math.sign(e.deltaY) !== Math.sign(wheelAcc)) wheelAcc = 0;
		wheelAcc += e.deltaY;
		// 이벤트당 최대 한 칸. selectBundleEntry 의 dispatch 는 동기라 k 가
		// 핸들러 안에서 즉시 갱신된다 — 누적 while 루프는 휠 한 칸(deltaY≈100)에
		// 두 스텝을 만들었다(threshold 50 + 잔여 이월). 스텝 후 잔여를 버려
		// 노치당 정확히 한 칸으로 고정; 트랙패드 미세 델타는 50까지 누적 후 발동.
		if (wheelAcc >= 50) {
			step(1);
			wheelAcc = 0;
		} else if (wheelAcc <= -50) {
			step(-1);
			wheelAcc = 0;
		}
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
			{#each resolved as e, idx (e.originalIndex)}
				{@const off = idx < winStart || idx > lastVisibleIdx}
				{@const session = e.guid ? sessions.get(e.guid) : undefined}
				<button
					type="button"
					class="bundle-bar"
					class:broken={e.broken}
					class:expanded-bar={idx === k}
					class:off
					data-idx={idx}
				>
					<span class="bar-title">{e.title}</span>
					{#if idx === winStart && hiddenAbove > 0}
						<span class="bar-badge">+{hiddenAbove}</span>
					{:else if idx === lastVisibleIdx && hiddenBelow > 0}
						<span class="bar-badge">+{hiddenBelow}</span>
					{/if}
				</button>
				{#if session}
					<div class="bundle-body" class:open={idx === k}>
						<EditorComponent
							content={session.content}
							currentGuid={session.guid}
							onchange={(doc: JSONContent) => handleEmbeddedChange(session.guid, doc)}
							oninternallink={(t: string) => oninternallink?.(t)}
							enableNoteBundle={false}
							hrSplitEnabled={false}
							createDate={session.createDate}
						/>
					</div>
				{:else if idx === k}
					<div class="bundle-body open loading">로딩…</div>
				{/if}
			{/each}
			{#if k < 0}
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
		position: relative;
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
		max-height: 3rem;
		border: none;
		border-bottom: 1px solid #1a1a1a;
		padding: clamp(4px, 1vw, 6px) clamp(8px, 2vw, 12px);
		background: #2a2a2a;
		color: #eee;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		overflow: hidden;
		touch-action: none; /* 바에서 시작한 스와이프가 pointercancel 로 죽지 않게 */
		user-select: none;
		/* 활성 전환·윈도우 진입/퇴장 전부 클래스 토글 → transition 이 흐름을 만든다 */
		transition:
			background-color 160ms ease-out,
			max-height 160ms ease-out,
			padding 160ms ease-out,
			opacity 160ms ease-out,
			transform 160ms ease-out;
	}
	/* 윈도우 밖 바 — 오른쪽(+N 배지 방향)으로 빨려 들어가며 접힘 */
	.bundle-bar.off {
		max-height: 0;
		padding-block: 0;
		border-bottom-width: 0;
		opacity: 0;
		transform: translateX(48px);
		pointer-events: none;
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
	/* 모든 세션 본문이 자기 바 밑에 상주 — 활성만 flex-grow:1. 전환은
	   flex-grow transition: 옛 본문 접히고 새 본문 펼쳐지는 서랍 모션이
	   레이아웃에서 일어나 바들이 매 프레임 자연히 따라 움직인다. */
	.bundle-body {
		flex: 0 1 0%;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--color-bg, #fff);
		transition: flex-grow 160ms ease-out;
	}
	.bundle-body.open {
		flex-grow: 1;
	}
	.bundle-body.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		color: #888;
		font-size: 0.85rem;
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
