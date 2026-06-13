<script lang="ts">
	/**
	 * 묶음 스택 — 브라우저 탭 형태의 재귀 파일철.
	 *
	 * noteBundlePlugin 의 위젯 컨테이너(외부 에디터의 contenteditable=false
	 * 섬) 안에 mount() 된다. 루트에서 입력/클립보드/포인터 이벤트를
	 * stopPropagation — 외부 PM 이 임베디드 에디터 이벤트를 보지 못하게
	 * 하는 editor-in-editor 격벽.
	 *
	 * ── 탭 모델 ─────────────────────────────────────────────────────────
	 * 각 레벨(루트/카테고리)은 [위 탭 스트립][본문][아래 탭 스트립] 구조.
	 * - 위 스트립: 활성 + 이후 노트(활성이 최좌측), 왼→오.
	 * - 본문: 활성 탭의 노트(잎=에디터, 카테고리=재귀 탭 레벨).
	 * - 아래 스트립: 지나간(스크롤로 내려간) 노트, 역순(가장 오래된 게 최우측).
	 * 카테고리가 활성이면 본문 상단/하단에 자기 탭 스트립이 재귀로 생긴다.
	 * 카테고리가 자기 링크를 가지면 그 링크가 첫 하위 탭(자신을 첫 탭에 로드).
	 *
	 * 탭 폭은 균등 분배(최소 1/4, 말줄임). 한 스트립에 최대 4개, 넘치면
	 * 우측에 작은 +N 탭(stackMath.tabWindow).
	 *
	 * 활성 경로(activePath)는 영속하지 않는 컴포넌트 로컬 상태 — 재오픈/리마운트
	 * 시 첫 노트로. 파서/플러그인은 리스트 내용을 수정하지 않는다.
	 *
	 * ── keep-alive ─────────────────────────────────────────────────────
	 * 트리 전체를 렌더하되 비활성 가지는 display:none. 잎 에디터는 활성화될
	 * 때 lazy mount 되고 이후 숨겨진 채 유지(언마운트 없음) — 재전환 즉시,
	 * 커서·실행취소 노트별 보존. EditorComponent 는 TomboyEditor 자신(셀프
	 * 임포트 주입, prop 으로 받아 순환 회피).
	 *
	 * ── 훑어보기 / 편집 모드 ─────────────────────────────────────────────
	 * 훑어보기(기본): 휠/스와이프 = 탭 전환. 데스크톱 휠은 아래로 굴리면
	 * 다음(이후) 노트 — 탭 구조라 이전 세로 스택과 방향이 반대. 활성 본문은
	 * 회색조. 본문 탭/클릭 → 편집 모드(흰 배경, 휠/스크롤이 노트 안으로).
	 * Esc · 탭 클릭 · 묶음 스크롤(휠/스와이프, ctrl+휠) → 훑어보기 복귀.
	 *
	 * ── 호스트 셸 배선 ──────────────────────────────────────────────────
	 * 터미널/음악/하단최신은 잎 본문에 그대로. TerminalView·MusicPlayerBar 는
	 * 격벽이 Svelte 위임 이벤트를 죽이므로 본문에 독립 mount().
	 */
	import { onMount, onDestroy, untrack, mount as mountComponent, unmount as unmountComponent } from 'svelte';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Component } from 'svelte';
	import type { EditorView } from '@tiptap/pm/view';
	import type { JSONContent } from '@tiptap/core';
	import type { BundleSpec, BundleNode } from './parser.js';
	import { writeBundleHeightPct } from './noteBundlePlugin.js';
	import {
		firstNavPath,
		repairPath,
		stepPath,
		pickPath,
		tabWindow,
		clampIndex,
		topItems,
		bottomItems
	} from './stackMath.js';
	import { lookupGuidByTitle, ensureTitleIndexReady } from '../autoLink/titleProvider.js';
	import {
		getNote,
		getNoteEditorContent,
		updateNoteFromEditor
	} from '$lib/core/noteManager.js';
	import { subscribeNoteReload, subscribeNoteFlush } from '$lib/core/noteReloadBus.js';
	import { attachOpenNote, detachOpenNote } from '$lib/sync/firebase/orchestrator.js';
	import { parseTerminalNote, type TerminalNoteSpec } from '../terminal/parseTerminalNote.js';
	import TerminalView from '../terminal/TerminalView.svelte';
	import { isScrollBottomNote } from '$lib/core/scrollBottom.js';
	import { isMusicNoteDoc } from '$lib/music/parseMusicNote.js';
	import MusicPlayerBar from '../musicNote/MusicPlayerBar.svelte';

	interface Props {
		spec: BundleSpec;
		view: EditorView;
		hostGuid: string | null;
		// Component<any>: svelte-check 가 실제 TomboyEditor props 와 대조할 때
		// Record<string,unknown> 이 enableNoteBundle 등 선택적 prop 와 충돌하면
		// any 로 완화한다.
		EditorComponent: Component<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
		oninternallink?: (target: string) => void;
	}
	let { spec, view, hostGuid, EditorComponent, oninternallink }: Props = $props();

	// --- 트리 해석 ----------------------------------------------------------
	let titleEpoch = $state(0);
	// 초기 렌더에서 탭 intro 트랜지션이 한꺼번에 깜빡이지 않게, 마운트 후에만
	// 트랜지션 시간을 켠다(그 전엔 duration 0 = 즉시).
	let ready = $state(false);
	onMount(() => {
		ready = true;
		void ensureTitleIndexReady().then(() => {
			titleEpoch++;
		});
	});

	interface ResolvedNode {
		/** #each 키 — 트리 위치 경로 문자열(구조 안정 + 중복 링크 구분) */
		key: string;
		label: string;
		/** 잎이면 링크 target, 카테고리면 null */
		link: string | null;
		/** 잎 전용 — 해석된 guid */
		guid: string | null;
		/** 잎이 링크 미해석(삭제됨) */
		broken: boolean;
		isLeaf: boolean;
		/** 펼침 가능: 잎이면 !broken, 카테고리면 navigable 자손 존재 */
		navigable: boolean;
		children: ResolvedNode[];
	}

	function resolveNodes(nodes: BundleNode[], keyPrefix: string): ResolvedNode[] {
		const out: ResolvedNode[] = [];
		nodes.forEach((n, i) => {
			const key = `${keyPrefix}.${i}`;
			if (n.link !== null && n.children.length === 0) {
				const guid = lookupGuidByTitle(n.link);
				if (guid !== null && guid === hostGuid) return; // 자기참조 제외
				out.push({
					key,
					label: n.label,
					link: n.link,
					guid,
					broken: guid === null,
					isLeaf: true,
					navigable: guid !== null,
					children: []
				});
			} else {
				const children = resolveNodes(n.children, key);
				out.push({
					key,
					label: n.label,
					link: n.link,
					guid: null,
					broken: false,
					isLeaf: false,
					navigable: children.some((c) => c.navigable),
					children
				});
			}
		});
		return out;
	}

	const tree = $derived.by<ResolvedNode[]>(() => {
		void titleEpoch;
		return resolveNodes(spec.tree, 'r');
	});

	// --- 활성 경로 (로컬 state, 영속 안 함) -------------------------------------
	let activePath = $state<number[]>([]);
	// tree 변화 시 경로 보정: 여전히 navigable 잎을 가리키면 유지, 아니면 첫 잎.
	// activePath 를 읽고 쓰므로 untrack — tree 변화에만 반응.
	$effect(() => {
		const t = tree;
		untrack(() => {
			const repaired = repairPath(t, activePath);
			if (repaired !== activePath) activePath = repaired;
		});
	});

	// 활성 잎(가장 깊은 노드) — 본문에 보일 노트
	const activeLeaf = $derived.by<ResolvedNode | null>(() => {
		let nodes = tree;
		let node: ResolvedNode | null = null;
		for (const idx of activePath) {
			node = nodes[idx] ?? null;
			if (!node) return null;
			nodes = node.children;
		}
		return node && node.isLeaf ? node : null;
	});
	const activeLeafGuid = $derived(activeLeaf?.guid ?? null);

	// 스트립 항목 빌더는 stackMath(topItems/bottomItems)로 이동 — activeIdx 가
	// 범위 밖이어도(재귀 비활성 형제) undefined 노드를 만들지 않게 clamp 포함.

	// --- 높이 ----------------------------------------------------------------
	let rootEl = $state<HTMLElement | null>(null);
	let basisH = $state(600);
	let dragPx = $state<number | null>(null);
	const stackH = $derived(dragPx ?? Math.max(140, Math.round((basisH * spec.heightPct) / 100)));

	onMount(() => {
		// 데스크톱 멀티윈도우(.note-window)는 창이 높이를 한정 → 호스트
		// 에디터 clientHeight 안정적. 모바일 라우트는 본문이 body 스크롤로
		// 콘텐츠만큼 자라고 그 안에 묶음이 포함돼, clientHeight 기준이면
		// 측정→성장 피드백 루프(무한 증식). 모바일은 화면 높이(innerHeight)를
		// 기준 — 콘텐츠와 무관해 루프가 끊긴다.
		const inDesktopWindow = !!view.dom.closest('.note-window');
		if (inDesktopWindow) {
			const hostEl = view.dom.closest<HTMLElement>('.tomboy-editor') ?? view.dom.parentElement;
			if (!hostEl) return;
			basisH = hostEl.clientHeight || 600;
			const ro = new ResizeObserver(() => {
				basisH = hostEl.clientHeight || basisH;
			});
			ro.observe(hostEl);
			return () => ro.disconnect();
		}
		const measure = () => {
			basisH = window.innerHeight || 600;
		};
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
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
		// Ctrl/Cmd+Home/End: 크롬이 중첩 편집 섬에서 바깥 에디터를 호스트로 보고
		// 캐럿을 탈출시켜 호스트 노트를 오염 — 이 둘만 기본 동작 차단.
		// 화살표/Page 도 같은 계열: 이동 후 탈출 감지되면 키 이전 위치로 복원.
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
				const bc = before.startContainer;
				if (!bc.isConnected) return;
				try {
					const bcEl = bc.nodeType === Node.ELEMENT_NODE ? (bc as Element) : bc.parentElement;
					bcEl?.closest<HTMLElement>('.ProseMirror')?.focus({ preventScroll: true });
					s?.removeAllRanges();
					s?.addRange(before);
				} catch {
					/* 스냅샷 무효화 — 복원 포기 */
				}
			}, 0);
		};
		const stopKeydown = (e: Event) => {
			const ke = e as KeyboardEvent;
			if ((ke.ctrlKey || ke.metaKey) && (ke.key === 'Home' || ke.key === 'End')) {
				ke.preventDefault();
			}
			if (ke.key === 'Escape' && mode === 'edit') {
				const t = ke.target as HTMLElement | null;
				if (!t?.closest?.('.bundle-term')) exitEdit();
			}
			if (NAV_KEYS.has(ke.key)) guardCaretEscape();
			ke.stopPropagation();
		};
		const pairs: Array<[string, (e: Event) => void]> = ISOLATED_EVENTS.map(
			(t) => [t, t === 'keydown' ? stopKeydown : stop]
		);
		for (const [t, h] of pairs) el.addEventListener(t, h);
		// 훑어보기(또는 ctrl/⌘+휠)의 휠은 캡처 단계에서 선점 — xterm/임베디드 PM 이
		// 타깃 단계에서 자체 스크롤해 버리면 버블 preventDefault 로 못 되돌린다.
		const captureWheel = (e: Event) => {
			const we = e as WheelEvent;
			if (mode === 'browse' || we.ctrlKey || we.metaKey) flipWheel(we);
		};
		el.addEventListener('wheel', captureWheel, { capture: true, passive: false });
		// 모바일 편집-진입 키보드 억제: 임베디드 PM 은 "편집 모드 + 활성 본문 직접
		// 탭"일 때만 포커스(=키보드)를 얻는다. 그 외 본문 위 mousedown/touchstart 는
		// 캡처 단계에서 preventDefault 로 포커스 디폴트를 차단 — 훑어보기에서 본문을
		// 탭하면 모드만 바뀌고(키보드 안 뜸), 다시 탭해야 타이핑이 시작된다.
		// 탭 스트립(.tab)은 click 으로 전환하므로 건드리지 않는다(모바일 탭 click 보존).
		const suppressEditorFocus = (e: Event) => {
			const t = e.target as HTMLElement | null;
			const body = t?.closest?.('.bundle-body');
			if (!body) return;
			if (mode === 'edit' && body.closest('.node-body')?.classList.contains('active')) return;
			e.preventDefault();
		};
		el.addEventListener('mousedown', suppressEditorFocus, { capture: true });
		el.addEventListener('touchstart', suppressEditorFocus, { capture: true, passive: false });
		return () => {
			for (const [t, h] of pairs) el.removeEventListener(t, h);
			el.removeEventListener('wheel', captureWheel, { capture: true });
			el.removeEventListener('mousedown', suppressEditorFocus, { capture: true });
			el.removeEventListener('touchstart', suppressEditorFocus, { capture: true });
		};
	});

	// --- 에디터 세션 (노트별, lazy mount 후 유지 = keep-alive) -------------------
	interface EditorSession {
		guid: string;
		content: JSONContent;
		createDate: string | null;
		pendingDoc: JSONContent | null;
		saveTimer: ReturnType<typeof setTimeout> | null;
		offReload: () => void;
		offFlush: () => void;
		termSpec: TerminalNoteSpec | null;
		termConnect: boolean;
		scrollBottom: boolean;
		isMusic: boolean;
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
		// 시그니처(음악/터미널) 변화 때만 세션 교체 — 매 키스트로크 set churn 방지.
		const isMusic = isMusicNoteDoc(doc);
		const term = parseTerminalNote(doc);
		if (isMusic !== s.isMusic || !!term !== !!s.termSpec || term?.target !== s.termSpec?.target) {
			sessions.set(guid, { ...s, isMusic, termSpec: term });
		}
	}

	async function loadSession(guid: string) {
		if (sessions.has(guid) || loading.has(guid)) return;
		loading.add(guid);
		try {
			const [note, scrollBottom] = await Promise.all([getNote(guid), isScrollBottomNote(guid)]);
			if (!note || destroyed || sessions.has(guid)) return;
			attachOpenNote(guid);
			const offReload = subscribeNoteReload(guid, async () => {
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
				if (fresh && live) {
					const content = getNoteEditorContent(fresh);
					sessions.set(guid, {
						...live,
						content,
						termSpec: parseTerminalNote(content),
						isMusic: isMusicNoteDoc(content)
					});
				}
			});
			const offFlush = subscribeNoteFlush(guid, () => flushSession(guid));
			const content = getNoteEditorContent(note);
			sessions.set(guid, {
				guid,
				content,
				createDate: note.createDate ?? null,
				pendingDoc: null,
				saveTimer: null,
				offReload,
				offFlush,
				termSpec: parseTerminalNote(content),
				termConnect: false,
				scrollBottom,
				isMusic: isMusicNoteDoc(content)
			});
		} finally {
			loading.delete(guid);
		}
	}

	function setTermConnect(guid: string, on: boolean) {
		const s = sessions.get(guid);
		if (!s) return;
		sessions.set(guid, { ...s, termConnect: on });
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

	// 활성 잎 세션 보장 (활성화될 때 visible 상태로 mount → 측정 정상)
	$effect(() => {
		const g = activeLeafGuid;
		if (g && !sessions.has(g)) void loadSession(g);
	});

	// 트리에서 빠진 노트 세션 정리 (사용자가 리스트를 편집한 경우).
	function collectGuids(nodes: ResolvedNode[], set: Set<string>) {
		for (const n of nodes) {
			if (n.guid) set.add(n.guid);
			collectGuids(n.children, set);
		}
	}
	$effect(() => {
		const valid = new Set<string>();
		collectGuids(tree, valid);
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
		let entries = Object.entries(handlers);
		for (const [t, h] of entries) node.addEventListener(t, h);
		return {
			update(next: Record<string, (e: Event) => void>) {
				for (const [t, h] of entries) node.removeEventListener(t, h);
				entries = Object.entries(next);
				for (const [t, h] of entries) node.addEventListener(t, h);
			},
			destroy() {
				for (const [t, h] of entries) node.removeEventListener(t, h);
			}
		};
	}

	// --- 훑어보기 / 편집 모드 ---------------------------------------------------
	let mode = $state<'browse' | 'edit'>('browse');

	function exitEdit() {
		if (mode !== 'edit') return;
		mode = 'browse';
		const ae = document.activeElement as HTMLElement | null;
		if (ae && rootEl?.contains(ae)) ae.blur();
	}

	/** "하단이 최신" 노트 — 본문 첫 마운트 직후 끝으로 스크롤(rAF×2). */
	function scrollBottomInit(node: HTMLElement, enabled: boolean) {
		if (!enabled) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				node.scrollTop = node.scrollHeight;
			});
		});
	}

	/** TerminalView 독립 mount() — 격벽이 Svelte 위임 이벤트를 죽이므로
	 *  위임 루트가 격벽 안쪽 div 가 되게 별도 마운트. */
	function mountTerminal(
		node: HTMLElement,
		params: { spec: TerminalNoteSpec; guid: string; onedit: () => void }
	) {
		const app = mountComponent(TerminalView, { target: node, props: params });
		return {
			destroy() {
				void unmountComponent(app);
			}
		};
	}

	// 세션별 임베디드 TomboyEditor 인스턴스 ref — MusicPlayerBar 가 라이브 Editor 요구.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let editorRefs = $state<Record<string, any>>({});

	/** MusicPlayerBar 도 같은 이유로 독립 mount(). bind:this 시점엔 내부 editor 가
	 *  아직 onMount 전일 수 있어 rAF 로 getEditor() 준비를 기다린다. */
	function mountMusicBar(node: HTMLElement, params: { guid: string }) {
		let app: ReturnType<typeof mountComponent> | null = null;
		let raf = 0;
		const tryMount = () => {
			const ed = editorRefs[params.guid]?.getEditor?.();
			if (ed) {
				app = mountComponent(MusicPlayerBar, { target: node, props: { editor: ed, guid: params.guid } });
			} else {
				raf = requestAnimationFrame(tryMount);
			}
		};
		tryMount();
		return {
			destroy() {
				cancelAnimationFrame(raf);
				if (app) void unmountComponent(app);
			}
		};
	}

	// --- 전환 (휠 / 스와이프 / 탭 클릭) ------------------------------------------
	function step(dir: 1 | -1) {
		exitEdit();
		const next = stepPath(tree, activePath, dir);
		if (next !== activePath) activePath = next;
	}

	let wheelAcc = 0;
	function flipWheel(e: WheelEvent) {
		exitEdit();
		e.preventDefault(); // ctrl+wheel 줌 차단 겸용
		e.stopPropagation();
		if (Math.sign(e.deltaY) !== Math.sign(wheelAcc)) wheelAcc = 0;
		wheelAcc += e.deltaY;
		// 탭 구조: 아래로 굴리면(deltaY>0) 다음(이후) 노트 — 이전 세로 스택과
		// 방향 반대. 노치당 정확히 한 칸(잔여 폐기).
		if (wheelAcc >= 50) {
			step(1);
			wheelAcc = 0;
		} else if (wheelAcc <= -50) {
			step(-1);
			wheelAcc = 0;
		}
	}

	// 탭 클릭: 단일=선택(+drill), 더블=단독 열기(잎). 격벽 때문에 manual 더블 판정.
	let lastTabKey: string | null = null;
	let lastTabTime = 0;
	function handleTabClick(depth: number, idx: number, node: ResolvedNode) {
		exitEdit();
		const id = `${depth}:${idx}:${node.key}`;
		const now = performance.now();
		if (lastTabKey === id && now - lastTabTime < 300) {
			if (node.isLeaf && !node.broken && node.link) oninternallink?.(node.link);
			lastTabKey = null;
			return;
		}
		lastTabKey = id;
		lastTabTime = now;
		if (!node.navigable) return;
		activePath = pickPath(tree, activePath, depth, idx);
	}

	// 본문 위 스와이프(전환) + 탭(편집 진입). 캡처 안 함 — 캡처하면 click 이
	// retarget 돼 PM 포커스(모바일 키보드)가 안 뜬다.
	let swipeY: number | null = null;
	let downY = 0;
	let swiped = false;
	let downOnBody = false;
	function handlePointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		if (t.closest?.('.tab') || t.closest?.('.bundle-music') || t.closest?.('.bar-term-btn')) return;
		swipeY = e.clientY;
		downY = e.clientY;
		swiped = false;
		downOnBody = !!t.closest?.('.bundle-body');
	}
	function handlePointerMove(e: PointerEvent) {
		if (swipeY === null) return;
		const dy = e.clientY - swipeY;
		if (Math.abs(dy) >= 30) {
			swiped = true;
			if (mode === 'browse') step(dy < 0 ? 1 : -1); // 위로 끌면 다음
			swipeY = e.clientY;
		}
	}
	function handlePointerUp(e: Event) {
		const pe = e as PointerEvent;
		if (downOnBody && !swiped && Math.abs(pe.clientY - downY) < 8 && mode === 'browse') {
			// 본문 탭 → 편집 모드만 전환. 포커스는 suppressEditorFocus 가 막아
			// 키보드 안 뜸 — 타이핑은 편집 모드에서 다시 탭.
			mode = 'edit';
		}
		swipeY = null;
		swiped = false;
		downOnBody = false;
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
		try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* released */ }
	}
	function handleResizeMove(e: PointerEvent) {
		if (dragPx === null) return;
		dragPx = Math.max(140, resizeStartH + (e.clientY - resizeStartY));
	}
	function handleResizeUp() {
		if (dragPx === null) return;
		const pct = Math.round((dragPx / Math.max(1, basisH)) * 100);
		dragPx = null;
		writeBundleHeightPct(view, spec.ordinal, pct);
	}
</script>

<div
	class="bundle-stack"
	class:browse={mode === 'browse'}
	bind:this={rootEl}
	style:height={`${stackH}px`}
	use:direct={{
		pointerdown: handlePointerDown as (e: Event) => void,
		pointermove: handlePointerMove as (e: Event) => void,
		pointerup: handlePointerUp,
		pointercancel: handlePointerUp
	}}
>
	{#if tree.length === 0}
		<div class="bundle-empty">묶을 노트 없음</div>
	{:else if activePath.length === 0}
		<div class="bundle-empty">펼칠 수 있는 노트 없음</div>
	{:else}
		{@render tabLevel(tree, 0, true)}
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

{#snippet strip(
	items: Array<{ node: ResolvedNode; idx: number }>,
	depth: number,
	isTop: boolean,
	activeIdx: number
)}
	{#if items.length > 0}
		{@const win = tabWindow(items.length)}
		<div class="tab-strip" class:bottom={!isTop}>
			{#each items.slice(0, win.shown) as it (it.node.key)}
				<button
					type="button"
					class="tab"
					class:active={isTop && it.idx === activeIdx}
					class:broken={it.node.isLeaf && it.node.broken}
					class:cat={!it.node.isLeaf}
					title={it.node.label}
					animate:flip={{ duration: ready ? 220 : 0 }}
					in:fade={{ duration: ready ? 150 : 0 }}
					out:fade={{ duration: ready ? 120 : 0 }}
					use:direct={{ click: () => handleTabClick(depth, it.idx, it.node) }}
				>
					<span class="tab-label">{it.node.label || '(빈 카테고리)'}</span>
				</button>
			{/each}
			{#if win.plus > 0}
				<span class="tab tab-plus">+{win.plus}</span>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet leafBody(node: ResolvedNode)}
	{@const session = node.guid ? sessions.get(node.guid) : undefined}
	{#if node.broken || !node.guid}
		<div class="bundle-body"><div class="leaf-msg">삭제된 노트</div></div>
	{:else if !session}
		<div class="bundle-body"><div class="leaf-msg">로딩…</div></div>
	{:else if session.termSpec && session.termConnect}
		<div class="bundle-body">
			{#key session.termSpec}
				<div
					class="bundle-term"
					use:mountTerminal={{
						spec: session.termSpec,
						guid: session.guid,
						onedit: () => setTermConnect(session.guid, false)
					}}
				></div>
			{/key}
		</div>
	{:else}
		<div class="bundle-body" use:scrollBottomInit={session.scrollBottom}>
			{#if session.termSpec && !session.termConnect}
				<button
					type="button"
					class="bar-term-btn"
					title="SSH 접속 — {session.termSpec.target}"
					use:direct={{
						click: () => {
							setTermConnect(node.guid!, true);
							mode = 'edit';
						}
					}}
				>접속 — {session.termSpec.target}</button>
			{/if}
			{#if session.isMusic}
				<div class="bundle-music" use:mountMusicBar={{ guid: session.guid }}></div>
			{/if}
			<EditorComponent
				bind:this={editorRefs[session.guid]}
				content={session.content}
				currentGuid={session.guid}
				onchange={(doc: JSONContent) => handleEmbeddedChange(session.guid, doc)}
				oninternallink={(t: string) => oninternallink?.(t)}
				enableNoteBundle={false}
				hrSplitEnabled={false}
				createDate={session.createDate}
			/>
		</div>
	{/if}
{/snippet}

{#snippet tabLevel(nodes: ResolvedNode[], depth: number, onPath: boolean)}
	<!-- activeIdx: 활성 경로 위면 activePath[depth], 아니면(비활성 형제 카테고리)
	     첫 탭. 어느 경우든 자기 노드 수로 clamp — 다른(더 깊은) 형제의 인덱스가
	     새어들어와 범위를 넘겨도 undefined 노드를 만들지 않는다. -->
	{@const activeIdx = clampIndex(nodes.length, onPath ? (activePath[depth] ?? 0) : 0)}
	<div class="tab-level">
		{@render strip(topItems(nodes, activeIdx), depth, true, activeIdx)}
		<div class="level-body">
			{#each nodes as node, i (node.key)}
				<div class="node-body" class:active={i === activeIdx} class:before={i < activeIdx}>
					{#if node.isLeaf}
						{@render leafBody(node)}
					{:else}
						{@render tabLevel(node.children, depth + 1, onPath && i === activeIdx)}
					{/if}
				</div>
			{/each}
		</div>
		{@render strip(bottomItems(nodes, activeIdx), depth, false, activeIdx)}
	</div>
{/snippet}

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
	.tab-level {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.level-body {
		position: relative; /* 본문 슬라이드 기준 + 넘침 클립 */
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	/* 본문은 전부 마운트 유지(keep-alive). 활성 외에는 화면 밖으로 transform.
	   탭이 오른쪽→왼쪽으로 밀리므로 본문도 가로축으로 슬라이드:
	   - 이후(upcoming) 노트: 오른쪽(100%)에 대기 → 전진 시 왼쪽으로 들어와 채움.
	   - 지나간(before) 노트: 왼쪽(-100%)으로 빠짐.
	   display:none 대신 transform 이라 에디터 언마운트 없이 슬라이드. */
	.node-body {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		opacity: 0;
		pointer-events: none;
		transform: translateX(100%);
		transition:
			transform 240ms cubic-bezier(0.4, 0, 0.2, 1),
			opacity 200ms ease-out;
	}
	.node-body.before {
		transform: translateX(-100%);
	}
	.node-body.active {
		opacity: 1;
		pointer-events: auto;
		transform: translateX(0);
		z-index: 1;
	}
	@media (prefers-reduced-motion: reduce) {
		.node-body {
			transition: none;
		}
	}
	/* --- 탭 스트립 ---------------------------------------------------------- */
	.tab-strip {
		flex-shrink: 0;
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 2px 2px 0;
		background: #1a1a1a;
		overflow: hidden;
	}
	.tab-strip.bottom {
		padding: 0 2px 2px;
	}
	.tab {
		flex: 1 1 0;
		min-width: 0; /* 최소 1/4 는 최대 4탭(tabWindow) 보장으로 충족 */
		display: flex;
		align-items: center;
		border: none;
		border-radius: 5px 5px 0 0;
		padding: clamp(4px, 0.9vw, 6px) clamp(6px, 1.4vw, 10px);
		background: #2a2a2a;
		color: #cfcfcf;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		touch-action: manipulation;
		user-select: none;
		transition: background-color 140ms ease-out, color 140ms ease-out;
	}
	.tab-strip.bottom .tab {
		border-radius: 0 0 5px 5px;
		background: #232323;
		color: #9a9a9a;
	}
	.tab-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.tab.cat .tab-label::before {
		content: '▤ ';
		opacity: 0.6;
	}
	.tab.active {
		background: #2d5a3d;
		color: #fff;
	}
	.bundle-stack:not(.browse) .tab.active {
		background: #3f8657;
	}
	.tab.broken {
		color: #777;
		cursor: default;
	}
	.tab-plus {
		flex: 0 0 auto;
		color: #999;
		font-size: 0.72rem;
		cursor: default;
		background: #202020;
		justify-content: center;
		padding: clamp(4px, 0.9vw, 6px) 8px;
	}
	/* --- 본문 -------------------------------------------------------------- */
	.bundle-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--color-bg, #fff);
		transition: background-color 160ms ease-out;
	}
	/* 훑어보기 모드 — 활성 본문 회색조 + 탭 힌트. touch-action:none 으로
	   네이티브 스크롤 대신 스와이프 전환을 받는다. */
	.bundle-stack.browse .bundle-body {
		background: #ecebe6;
		cursor: pointer;
		touch-action: none;
	}
	.bundle-term {
		height: 100%;
	}
	/* 재생 컨트롤 — 본문 스크롤 컨테이너 상단에 sticky. .music-bar 자체 sticky 는
	   래퍼 박스에 갇혀 무효라 래퍼가 sticky 를 맡고 내부 바는 static. */
	.bundle-music {
		position: sticky;
		top: 0;
		z-index: 5;
	}
	.bundle-music :global(.music-bar) {
		position: static;
	}
	.bar-term-btn {
		display: block;
		margin: 6px;
		padding: 4px 10px;
		border: none;
		border-radius: 4px;
		background: #1e3a2a;
		color: #9fd4b3;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.bar-term-btn:hover {
		background: #163022;
	}
	.leaf-msg {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
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
