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
	 * 각 레벨(루트/카테고리)은 [탭 스트립(상단)][본문] 구조. 하단 스트립 없음.
	 * - 스트립: 항상 상단. 활성 탭을 가운데에 두는 윈도우(stackMath.visibleTabs).
	 * - 본문: 활성 탭의 노트(잎=에디터, 카테고리=재귀 탭 레벨). 가로 슬라이드.
	 * 카테고리가 활성이면 본문 상단에 자기 탭 스트립이 재귀로 생긴다.
	 * 카테고리가 자기 링크를 가지면 그 링크가 첫 하위 탭(자신을 첫 탭에 로드).
	 *
	 * 탭 폭은 내용(타이틀)에 맞춰 커지되 최소 1/4, 넘치면 말줄임. 4개 이하는
	 * 전부 고정 표시(활성 하이라이트만 이동); 5개 이상은 3개 윈도우 + 좌우 +N
	 * 작은 탭(숨은 수). 활성은 가운데(2번째), 처음/끝 탭만 예외.
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
	 * 훑어보기(기본): 휠/스와이프 = 탭 전환. 데스크톱 휠은 우세축(deltaX|deltaY)
	 * 양수면 다음(이후) 노트. 모바일은 좌우 스와이프만 인식(왼쪽으로 끌면 다음),
	 * 상하 제스처는 무시. 활성 본문은 회색조. 본문 탭/클릭 → 편집 모드.
	 * ctrl+휠은 모드 무관 활성 본문 스크롤(편집 진입 없이 내용 확인).
	 *
	 * 편집(단일 노트 뷰): 탭 스트립을 전부 숨겨(.edit) 노트 한 개만 보이는 듯한
	 * UI. 상단에 편집 헤더 — 제목 왼쪽 ← 돌아가기(훑어보기 복귀), 우측 ↗ 꺼내기
	 * (oninternallink 로 단독 열기). Esc · ← · 묶음 스크롤(휠/스와이프) → 훑어보기.
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
	import { writeBundleHeightPct, setBundleChecked } from './noteBundlePlugin.js';
	import {
		repairPath,
		stepPath,
		pickPath,
		visibleTabs,
		clampIndex,
		tabView,
		nodesAtDepth
	} from './stackMath.js';
	import type { VisibleTabs } from './stackMath.js';
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
	import { modKeys } from '$lib/desktop/modKeys.svelte.js';
	import { SEND_SOURCE_GUID } from '../sendListItem/transferListItem.js';
	import { shouldSendListBeActive } from '../sendListItem/sendActiveGate.js';
	import { getScheduleNoteGuid } from '$lib/core/schedule.js';

	interface Props {
		spec: BundleSpec;
		/** 인-에디터(인라인) 모드의 호스트 PM 뷰. 전용 노트 모드에선 null. */
		view: EditorView | null;
		hostGuid: string | null;
		// Component<any>: svelte-check 가 실제 TomboyEditor props 와 대조할 때
		// Record<string,unknown> 이 enableNoteBundle 등 선택적 prop 와 충돌하면
		// any 로 완화한다.
		EditorComponent: Component<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
		oninternallink?: (target: string) => void;
		/** 'inline' = 노트 본문 속 위젯(기본). 'dedicated' = 제목 `탭::` 전용
		 *  노트가 풀-노트로 띄운 모드 — 닫기/꺼내기 크롬 + Ctrl→일반 노트 토글. */
		variant?: 'inline' | 'dedicated';
		/** dedicated 닫기(✕) — 데스크탑 창에서만 제공(없으면 닫기 버튼 숨김 = 모바일). */
		onclose?: () => void;
		/** dedicated Ctrl→편집 — 호스트 노트를 일반 노트로 보기(링크 리스트 편집). */
		onraw?: () => void;
	}
	let {
		spec,
		view,
		hostGuid,
		EditorComponent,
		oninternallink,
		variant = 'inline',
		onclose,
		onraw
	}: Props = $props();
	const dedicated = $derived(variant === 'dedicated');

	// --- 트리 해석 ----------------------------------------------------------
	let titleEpoch = $state(0);
	// 초기 렌더에서 탭 intro 트랜지션이 한꺼번에 깜빡이지 않게, 마운트 후에만
	// 트랜지션 시간을 켠다(그 전엔 duration 0 = 즉시).
	let ready = $state(false);
	// 일정 노트 guid — 임베디드 에디터가 자동요일/일정 동기화를 켤지 판단. async
	// 해석되므로 $state, 미해석이면 null(일정 노트 아님으로 취급).
	let scheduleNoteGuid = $state<string | null>(null);
	onMount(() => {
		ready = true;
		void ensureTitleIndexReady().then(() => {
			titleEpoch++;
		});
		void getScheduleNoteGuid().then((g) => {
			scheduleNoteGuid = g ?? null;
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
	// 본문 슬라이드 억제 — 보이는 탭 윈도우가 실제로 이동하지 않는 전환에서는
	// 탭이 제자리라 슬라이드가 어색하다(5개+ 에서 활성 0↔1, 끝-1↔끝; 4개 이하
	// 전부 고정). 그땐 즉시 컷. activePath 바꾸기 직전 setActive 에서 계산.
	// (탭 flip 은 위치 변화가 없으면 자동으로 안 뜨므로 본문만 제어한다.)
	let suppressAnim = $state(false);

	/** old→new 전환에서 (가장 얕은 변경 레벨의) 윈도우 start 가 바뀌면 true. */
	function windowMoved(oldPath: number[], newPath: number[]): boolean {
		const maxLen = Math.max(oldPath.length, newPath.length);
		let d = -1;
		for (let i = 0; i < maxLen; i++) {
			if (oldPath[i] !== newPath[i]) {
				d = i;
				break;
			}
		}
		if (d < 0) return false;
		// d 위쪽 부모는 old/new 동일(첫 변경 깊이) → newPath 로 형제 목록 조회 OK.
		const nodes = nodesAtDepth(tree, newPath, d);
		if (!nodes) return false;
		const n = nodes.length;
		return tabView(n, oldPath[d] ?? 0).start !== tabView(n, newPath[d] ?? 0).start;
	}

	/** activePath 교체 + 윈도우 이동 여부로 본문 슬라이드 on/off. */
	function setActive(next: number[]) {
		suppressAnim = !windowMoved(activePath, next);
		activePath = next;
	}

	// tree 변화 시 경로 보정: 여전히 navigable 잎을 가리키면 유지, 아니면 첫 잎.
	// activePath 를 읽고 쓰므로 untrack — tree 변화에만 반응.
	$effect(() => {
		const t = tree;
		untrack(() => {
			const repaired = repairPath(t, activePath);
			if (repaired !== activePath) {
				suppressAnim = true; // 구조 보정 — 슬라이드 없이 즉시
				activePath = repaired;
			}
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

	// 스트립 윈도우는 stackMath(visibleTabs)로 — activeIdx 가 범위 밖이어도
	// (재귀 비활성 형제) undefined 노드를 만들지 않게 clamp 포함.

	// --- 높이 ----------------------------------------------------------------
	let rootEl = $state<HTMLElement | null>(null);
	let basisH = $state(600);
	let dragPx = $state<number | null>(null);
	const stackH = $derived(dragPx ?? Math.max(140, Math.round((basisH * spec.heightPct) / 100)));

	onMount(() => {
		// 전용 노트는 컨테이너(.editor-area / .body)를 flex:1 로 꽉 채운다 —
		// heightPct 기반 측정 불요. view 도 null 이라 아래 분기 자체를 건너뛴다.
		if (dedicated) return;
		// 데스크톱 멀티윈도우(.note-window)는 창이 높이를 한정 → 호스트
		// 에디터 clientHeight 안정적. 모바일 라우트는 본문이 body 스크롤로
		// 콘텐츠만큼 자라고 그 안에 묶음이 포함돼, clientHeight 기준이면
		// 측정→성장 피드백 루프(무한 증식). 모바일은 화면 높이(innerHeight)를
		// 기준 — 콘텐츠와 무관해 루프가 끊긴다.
		const inDesktopWindow = !!view!.dom.closest('.note-window');
		if (inDesktopWindow) {
			const hostEl = view!.dom.closest<HTMLElement>('.tomboy-editor') ?? view!.dom.parentElement;
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
		// 휠은 캡처 단계에서 선점 — xterm/임베디드 PM 이 타깃 단계에서 자체
		// 스크롤해 버리면 버블 preventDefault 로 못 되돌린다.
		//  - ctrl/⌘+휠: 활성 본문 스크롤(편집 진입 없이 내용 확인) + 줌 차단.
		//  - 훑어보기: 탭 전환. 편집(ctrl 없음): 통과 → 본문 네이티브 스크롤.
		const captureWheel = (e: Event) => {
			const we = e as WheelEvent;
			if (we.ctrlKey || we.metaKey) {
				scrollActiveBody(we);
				return;
			}
			if (mode === 'browse') flipWheel(we);
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

	// Ctrl 누른 채 우상단 편집 버튼 → 체크 해제. 선언 라인 + 리스트가 다시
	// 보이고(데코 해제) 위젯이 파괴되어 직접 편집 가능. modKeys.ctrl 로만 노출.
	const stopEvt = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
	};
	function handleUncheck(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		if (!view) return;
		setBundleChecked(view, spec.ordinal, false);
	}

	// 전용 노트 크롬 — Ctrl→편집(일반 노트로 보기) / 닫기(창).
	function handleRawEdit(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		onraw?.();
	}
	function handleClose(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		onclose?.();
	}

	// --- 훑어보기 / 편집 모드 ---------------------------------------------------
	let mode = $state<'browse' | 'edit'>('browse');

	function exitEdit() {
		if (mode !== 'edit') return;
		mode = 'browse';
		const ae = document.activeElement as HTMLElement | null;
		if (ae && rootEl?.contains(ae)) ae.blur();
	}

	// 편집 헤더 — ← 돌아가기(훑어보기) / ↗ 꺼내기(단독 열기).
	function handleEditBack(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		exitEdit();
	}
	function handleEject(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		const l = activeLeaf;
		if (l && !l.broken && l.link) oninternallink?.(l.link);
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
		if (next !== activePath) setActive(next);
	}

	/** ctrl/⌘+휠 — 활성 잎 노트 본문을 직접 스크롤(편집 진입 없이 내용 확인).
	 *  preventDefault 로 줌·네이티브 스크롤을 막고 scrollTop 직접 이동.
	 *  활성 잎 본문 = 가장 깊은 .node-body.active 의 직속 .bundle-body. */
	function scrollActiveBody(e: WheelEvent) {
		e.preventDefault();
		e.stopPropagation();
		const body = rootEl?.querySelector<HTMLElement>('.node-body.active > .bundle-body') ?? null;
		if (body) body.scrollTop += e.deltaY;
	}

	let wheelAcc = 0;
	function flipWheel(e: WheelEvent) {
		exitEdit();
		e.preventDefault(); // 네이티브 본문 스크롤 차단(브라우징 중)
		e.stopPropagation();
		// 가로 탭이라 우세축 사용 — 마우스 휠(deltaY) / 트랙패드 가로(deltaX) 둘 다.
		const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0;
		wheelAcc += d;
		// 양수(아래/오른쪽)면 다음(이후) 노트. 노치당 정확히 한 칸(잔여 폐기).
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
		setActive(pickPath(tree, activePath, depth, idx));
	}

	// 본문 위 가로 스와이프(전환) + 탭(편집 진입). 가로만 — 상하 제스처는 무시
	// (스크롤 의도). 캡처 안 함 — 캡처하면 click 이 retarget 돼 PM 포커스(모바일
	// 키보드)가 안 뜬다.
	let swipeX: number | null = null;
	let downX = 0;
	let downY = 0;
	let swiped = false;
	let downOnBody = false;
	function handlePointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		if (t.closest?.('.tab') || t.closest?.('.bundle-music') || t.closest?.('.bar-term-btn')) return;
		swipeX = e.clientX;
		downX = e.clientX;
		downY = e.clientY;
		swiped = false;
		downOnBody = !!t.closest?.('.bundle-body');
	}
	function handlePointerMove(e: PointerEvent) {
		if (swipeX === null) return;
		const dx = e.clientX - swipeX;
		if (Math.abs(dx) >= 30) {
			swiped = true;
			if (mode === 'browse') step(dx < 0 ? 1 : -1); // 왼쪽으로 끌면 다음(이후)
			swipeX = e.clientX;
		}
	}
	function handlePointerUp(e: Event) {
		const pe = e as PointerEvent;
		if (
			downOnBody &&
			!swiped &&
			Math.abs(pe.clientX - downX) < 8 &&
			Math.abs(pe.clientY - downY) < 8 &&
			mode === 'browse'
		) {
			// 본문 탭 → 편집 모드만 전환. 포커스는 suppressEditorFocus 가 막아
			// 키보드 안 뜸 — 타이핑은 편집 모드에서 다시 탭.
			mode = 'edit';
		}
		swipeX = null;
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
		if (view) writeBundleHeightPct(view, spec.ordinal, pct);
	}
</script>

<div
	class="bundle-stack"
	class:browse={mode === 'browse'}
	class:edit={mode === 'edit'}
	class:no-anim={suppressAnim}
	class:dedicated
	bind:this={rootEl}
	style:height={dedicated ? null : `${stackH}px`}
	use:direct={{
		pointerdown: handlePointerDown as (e: Event) => void,
		pointermove: handlePointerMove as (e: Event) => void,
		pointerup: handlePointerUp,
		pointercancel: handlePointerUp
	}}
>
	{#if mode === 'edit' && activeLeaf}
		<div class="edit-header">
			<button
				type="button"
				class="edit-nav edit-back"
				title="훑어보기로 돌아가기"
				use:direct={{ click: handleEditBack, pointerdown: stopEvt, mousedown: stopEvt }}
			>←</button>
			<span class="edit-title">{activeLeaf.label || '(제목 없음)'}</span>
			<button
				type="button"
				class="edit-nav edit-eject"
				title="노트 단독으로 열기"
				use:direct={{ click: handleEject, pointerdown: stopEvt, mousedown: stopEvt }}
			>↗</button>
		</div>
	{/if}
	{#if tree.length === 0}
		<div class="bundle-empty">묶을 노트 없음</div>
	{:else if activePath.length === 0}
		<div class="bundle-empty">펼칠 수 있는 노트 없음</div>
	{:else}
		{@render tabLevel(tree, 0, true)}
	{/if}
	{#if dedicated}
		<!-- 전용 노트 크롬(훑어보기 전용) — 우상단 [✎편집(Ctrl)][↗꺼내기][✕닫기].
		     편집 모드에선 .edit-header 가 ←/↗ 를 맡으므로 여기선 안 띄운다. -->
		{#if mode === 'browse'}
			<div class="dedicated-chrome">
				{#if modKeys.ctrl}
					<button
						type="button"
						class="dchrome-btn"
						title="편집 (일반 노트로 보기)"
						use:direct={{ click: handleRawEdit, pointerdown: stopEvt, mousedown: stopEvt }}
					>✎ 편집</button>
				{/if}
				<button
					type="button"
					class="dchrome-btn"
					title="활성 노트 단독으로 열기"
					use:direct={{ click: handleEject, pointerdown: stopEvt, mousedown: stopEvt }}
				>↗ 꺼내기</button>
				{#if onclose}
					<button
						type="button"
						class="dchrome-btn dchrome-close"
						title="닫기"
						use:direct={{ click: handleClose, pointerdown: stopEvt, mousedown: stopEvt }}
					>✕</button>
				{/if}
			</div>
		{/if}
	{:else if modKeys.ctrl}
		<button
			type="button"
			class="bundle-edit-btn"
			title="편집 (체크 해제)"
			use:direct={{ click: handleUncheck, pointerdown: stopEvt, mousedown: stopEvt }}
		>✎ 편집</button>
	{/if}
	{#if !dedicated}
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
	{/if}
</div>

{#snippet strip(vis: VisibleTabs<ResolvedNode>, depth: number, activeIdx: number)}
	{#if vis.items.length > 0}
		<div class="tab-strip">
			{#if vis.leftPlus > 0}
				<span class="tab tab-plus">+{vis.leftPlus}</span>
			{/if}
			{#each vis.items as it (it.node.key)}
				<button
					type="button"
					class="tab"
					class:active={it.idx === activeIdx}
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
			{#if vis.rightPlus > 0}
				<span class="tab tab-plus">+{vis.rightPlus}</span>
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
				hideTitleLine={true}
				isScheduleNote={session.guid === scheduleNoteGuid}
				sendListItemActive={shouldSendListBeActive({
					guid: session.guid,
					sourceGuid: SEND_SOURCE_GUID,
					ctrlHeld: modKeys.ctrl,
					focusedGuid: null,
					ignoreFocus: true
				})}
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
		{@render strip(visibleTabs(nodes, activeIdx), depth, activeIdx)}
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
	/* 전용 노트 — 컨테이너(.editor-area / .body)를 꽉 채우고 카드 테두리/여백 제거. */
	.bundle-stack.dedicated {
		flex: 1;
		min-height: 0;
		margin: 0;
		border: none;
		border-radius: 0;
		position: relative;
	}
	/* 전용 노트 우상단 크롬 — 반투명, 본문 위로 떠 있음. */
	.dedicated-chrome {
		position: absolute;
		top: 4px;
		right: 4px;
		z-index: 6;
		display: flex;
		gap: 4px;
	}
	.dchrome-btn {
		padding: 3px 9px;
		font-size: 12px;
		line-height: 1.4;
		color: #fff;
		background: rgba(38, 38, 38, 0.82);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		opacity: 0.82;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
	}
	.dchrome-btn:hover {
		opacity: 1;
	}
	.dchrome-close {
		background: rgba(122, 46, 46, 0.9);
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
	/* 윈도우가 안 움직이는 전환(탭 제자리) — 본문 슬라이드 생략, 즉시 컷. */
	.bundle-stack.no-anim .node-body {
		transition: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.node-body {
			transition: none;
		}
	}
	/* --- 탭 스트립(상단 전용) ----------------------------------------------- */
	.tab-strip {
		flex-shrink: 0;
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 2px 2px 0;
		background: #1a1a1a;
		overflow: hidden;
	}
	.tab {
		/* 내용(타이틀) 폭에 맞춰 커지되 넘치면 shrink+말줄임, 최소 1/4. */
		flex: 0 1 auto;
		min-width: 25%;
		max-width: 100%;
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
	/* 숨은 탭 수 배지 — 좌/우 끝의 작은 고정폭 탭([+N]). */
	.tab-plus {
		flex: 0 0 auto;
		min-width: 0;
		justify-content: center;
		color: #999;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: default;
		background: #202020;
		padding: clamp(4px, 0.9vw, 6px) 7px;
	}
	/* --- 편집 모드(단일 노트 뷰) ------------------------------------------- */
	/* 탭 스트립 전부 숨김 → 활성 본문만 남아 노트 한 개처럼 보인다. */
	.bundle-stack.edit .tab-strip {
		display: none;
	}
	.edit-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: clamp(4px, 0.9vw, 6px) clamp(6px, 1.4vw, 10px);
		background: #2d5a3d;
		border-bottom: 1px solid #1a1a1a;
	}
	.edit-nav {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
	}
	.edit-nav:hover {
		background: rgba(255, 255, 255, 0.28);
	}
	.edit-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #fff;
		font-size: 0.8rem;
		font-weight: 500;
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
	/* 훑어보기 모드 — 활성 본문 회색조 + 탭 힌트. touch-action:pan-y 로 좌우
	   스와이프는 JS(탭 전환)가, 상하는 브라우저(페이지 스크롤)가 가져간다. */
	.bundle-stack.browse .bundle-body {
		background: #ecebe6;
		cursor: pointer;
		touch-action: pan-y;
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
	/* Ctrl 누른 동안만 노출되는 편집(체크 해제) 버튼 — 우상단 오버레이. */
	.bundle-edit-btn {
		position: absolute;
		top: 4px;
		right: 4px;
		z-index: 5;
		padding: 2px 8px;
		font-size: 12px;
		line-height: 1.4;
		color: #fff;
		background: #3f8657;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		opacity: 0.92;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
	}
	.bundle-edit-btn:hover {
		opacity: 1;
	}
</style>
