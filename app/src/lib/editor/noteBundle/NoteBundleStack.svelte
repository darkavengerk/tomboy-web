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
	 *
	 * ── 훑어보기 / 편집 모드 ─────────────────────────────────────────────
	 * 훑어보기(기본): 스택 어디서든 휠/스와이프 = 묶음 브라우징(노트 전환),
	 * 활성 본문은 회색조 + 포인터 커서. 본문 탭/클릭 → 편집 모드: 본문이
	 * 흰 배경으로 바뀌고 휠/스크롤이 노트 내부로 들어간다. Esc · 타이틀 바
	 * 클릭 · 묶음 스크롤(바 위 휠/스와이프, ctrl+휠) → 훑어보기 복귀.
	 *
	 * ── 호스트 셸 배선 ──────────────────────────────────────────────────
	 * 터미널 노트: 활성 바에 "접속" 버튼 → TerminalView 를 본문에 별도
	 * mount() (격벽이 Svelte 위임 이벤트를 죽이므로 — 위임 루트가 격벽
	 * 안쪽이 되도록 독립 마운트). "하단이 최신" 노트는 세션 첫 마운트 때
	 * 본문(.bundle-body 스크롤 컨테이너)을 끝까지 내린다.
	 */
	import { onMount, onDestroy, untrack, mount as mountComponent, unmount as unmountComponent } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { Component } from 'svelte';
	import type { EditorView } from '@tiptap/pm/view';
	import type { JSONContent } from '@tiptap/core';
	import type { BundleSpec } from './parser.js';
	import { writeBundleHeightPct } from './noteBundlePlugin.js';
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
		/** 상위 들여쓰기 항목의 전체 타이틀 — 바에 우측정렬 표시 */
		category: string | null;
		guid: string | null;
		broken: boolean;
		/** spec.entries 인덱스 — #each 키 안정화용(중복 링크 구분) */
		srcIndex: number;
	}
	const resolved = $derived.by<ResolvedEntry[]>(() => {
		void titleEpoch;
		const out: ResolvedEntry[] = [];
		spec.entries.forEach((e, i) => {
			const guid = lookupGuidByTitle(e.title);
			if (guid !== null && guid === hostGuid) return; // 자기참조 제외
			out.push({
				title: e.title,
				category: e.category,
				guid,
				broken: guid === null,
				srcIndex: i
			});
		});
		return out;
	});

	// 펼침 인덱스(resolved 기준) — 로컬 state, 영속 안 함. 재오픈/리마운트 시
	// 첫 유효 노트가 보인다. 라디오/XML 에 활성 정보를 쓰지 않는다.
	let k = $state(-1);
	// resolved 변화 시 k 초기화/보정: 범위 밖·broken 이면 첫 유효 항목으로.
	// k 를 읽고 쓰므로 untrack — resolved 변화에만 반응(effect_update_depth 함정).
	$effect(() => {
		const n = resolved.length;
		untrack(() => {
			if (n === 0) {
				if (k !== -1) k = -1;
				return;
			}
			if (k < 0 || k >= n || resolved[k].broken) {
				const v = firstValidIndex(resolved);
				if (v !== k) k = v;
			}
		});
	});
	const expanded = $derived(k >= 0 && k < resolved.length ? resolved[k] : null);

	// --- 타이틀 윈도우 ---------------------------------------------------------
	// winStart·k(활성) 모두 컴포넌트 로컬 — 영속 안 함.
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
	let basisH = $state(600);
	let dragPx = $state<number | null>(null);
	const stackH = $derived(dragPx ?? Math.max(140, Math.round((basisH * spec.heightPct) / 100)));

	onMount(() => {
		// 데스크톱 멀티윈도우(.note-window)는 창이 높이를 한정 → 호스트
		// 에디터 clientHeight 가 안정적. 모바일 라우트는 본문이 body 스크롤로
		// 콘텐츠만큼 자라고 그 안에 묶음이 포함돼, clientHeight 를 기준으로
		// 잡으면 측정→성장 피드백 루프(무한 증식)가 생긴다. 모바일은 화면
		// 높이(innerHeight, 레이아웃 뷰포트)를 기준 — 콘텐츠와 무관해 루프가 끊긴다.
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
			// Esc = 편집 → 훑어보기 복귀. 터미널 안 Esc 는 터미널 몫(vim 등).
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
		// 훑어보기 모드(또는 ctrl/⌘+휠)의 휠은 캡처 단계에서 선점 — xterm 이
		// 자기 DOM 에 단 wheel 리스너가 타깃 단계에서 버퍼를 스크롤해 버리면
		// 버블의 preventDefault 로는 못 되돌린다(임베디드 PM 스크롤도 동류).
		// flipWheel 의 stopPropagation 이 하강 자체를 끊는다.
		const captureWheel = (e: Event) => {
			const we = e as WheelEvent;
			if (mode === 'browse' || we.ctrlKey || we.metaKey) flipWheel(we);
		};
		el.addEventListener('wheel', captureWheel, { capture: true, passive: false });
		return () => {
			for (const [t, h] of pairs) el.removeEventListener(t, h);
			el.removeEventListener('wheel', captureWheel, { capture: true });
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
		/** 터미널 노트면 spec — 활성 바에 "접속" 버튼 노출 */
		termSpec: TerminalNoteSpec | null;
		/** 접속 중 = 본문이 TerminalView */
		termConnect: boolean;
		/** "하단이 최신" 노트 — 첫 마운트 때 본문을 끝까지 스크롤 */
		scrollBottom: boolean;
		/** 음악 노트 — 본문 상단에 MusicPlayerBar 표시 */
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
		// 호스트 셸과 동일하게 편집 중 시그니처 등장/소멸을 즉시 반영한다.
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

	// --- 훑어보기 / 편집 모드 ---------------------------------------------------
	// browse(기본): 묶음 전체가 휠/스와이프를 받아 노트를 브라우징.
	// edit: 본문 클릭으로 진입 — 휠/스크롤이 활성 노트 내부로 들어간다.
	let mode = $state<'browse' | 'edit'>('browse');

	function exitEdit() {
		if (mode !== 'edit') return;
		mode = 'browse';
		// 임베디드 에디터에 남은 포커스 제거 — 이후 타이핑이 노트로 새지 않게
		const ae = document.activeElement as HTMLElement | null;
		if (ae && rootEl?.contains(ae)) ae.blur();
	}

	/** "하단이 최신" 노트 — 세션 첫 마운트 직후 본문 스크롤을 끝으로.
	 *  rAF×2: 임베디드 에디터가 setContent + 레이아웃을 마친 다음 프레임. */
	function scrollBottomInit(node: HTMLElement, enabled: boolean) {
		if (!enabled) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				node.scrollTop = node.scrollHeight;
			});
		});
	}

	/** TerminalView 를 독립 mount() — NoteBundleStack 트리 안에 넣으면 Svelte
	 *  위임 이벤트(onclick 등)의 위임 루트가 격벽 바깥(위젯 컨테이너)이라
	 *  stopPropagation 에 전부 죽는다. 별도 mount 는 위임 루트가 이 div 가
	 *  되어 격벽 안쪽에서 정상 동작. */
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

	/** 세션별 임베디드 TomboyEditor 인스턴스 ref — MusicPlayerBar 가 라이브
	 *  Editor 를 요구한다. bind:this 시점엔 내부 editor 가 아직 onMount 전일
	 *  수 있어 mountMusicBar 가 rAF 로 getEditor() 준비를 기다린다. */
	// Component<any> 의 인스턴스 타입(SvelteComponent)과 노출 메서드가 안 맞아
	// any — 실제로는 TomboyEditor 의 export function getEditor().
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let editorRefs = $state<Record<string, any>>({});

	/** MusicPlayerBar 도 TerminalView 와 같은 이유로 독립 mount() — 위임
	 *  onclick 이 격벽에 죽지 않게. */
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

	// --- 전환 (휠 / 스와이프 / 바 클릭) ------------------------------------------
	// 활성 인덱스 k 는 로컬 state — 전환은 k 직접 변경(뷰 디스패치/영속 없음).
	function moveTo(target: number) {
		if (target < 0 || target >= resolved.length || target === k) return;
		if (resolved[target].broken) return;
		k = target;
	}

	function step(dir: 1 | -1) {
		exitEdit(); // 묶음 스크롤 = 훑어보기 복귀 (스와이프 경로 포함)
		if (k < 0) return;
		const target = nextValidIndex(resolved, k, dir);
		if (target === k) return;
		pendingDir = dir;
		k = target;
	}

	let wheelAcc = 0;
	function flipWheel(e: WheelEvent) {
		exitEdit(); // 묶음 스크롤 의도 — 임계 미달 누적이어도 복귀
		e.preventDefault(); // ctrl+wheel 브라우저 줌 차단 겸용
		e.stopPropagation();
		// 방향 반전 시 잔여 폐기 — 반대 방향 첫 응답이 굼뜨지 않게
		if (Math.sign(e.deltaY) !== Math.sign(wheelAcc)) wheelAcc = 0;
		wheelAcc += e.deltaY;
		// 이벤트당 최대 한 칸. k 변경은 동기라 핸들러 안에서 즉시 반영된다 —
		// 스텝 후 잔여를 버려 노치당 정확히 한 칸으로 고정; 트랙패드 미세
		// 델타는 50까지 누적 후 발동.
		// 데스크톱 휠 방향은 반전: 아래로 굴리면(deltaY>0) 이전 파일철, 위로
		// 굴리면 다음 — 더 직관적. (모바일 스와이프는 pointer 경로라 무관.)
		if (wheelAcc >= 50) {
			step(-1);
			wheelAcc = 0;
		} else if (wheelAcc <= -50) {
			step(1);
			wheelAcc = 0;
		}
	}
	function handleListWheel(e: Event) {
		const we = e as WheelEvent;
		if (we.ctrlKey || we.metaKey) {
			flipWheel(we);
			return;
		}
		// 편집 모드에서만 콘텐츠 위 일반 wheel = 임베디드 스크롤.
		// 훑어보기 모드는 스택 어디서든 wheel = 묶음 브라우징.
		if (mode === 'edit' && (we.target as HTMLElement).closest?.('.bundle-body')) return;
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
	/** 훑어보기 모드에서 열린 본문 위 pointerdown — 탭이면 편집 모드 진입 */
	let downBodyEdit = false;
	let lastTapIdx: number | null = null;
	let lastTapTime = 0;

	function handleListPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		if (t.closest?.('.bar-term-btn')) return; // 접속 버튼 — 자체 click 핸들러
		// 재생 컨트롤 — 조작이 편집 모드 진입/스와이프로 안 새게. click 은
		// 독립 mount 된 MusicPlayerBar 가 직접 받는다.
		if (t.closest?.('.bundle-music')) return;
		const body = t.closest?.('.bundle-body') as HTMLElement | null;
		if (body) {
			// 편집 모드: 노트 내부 인터랙션 — 손대지 않음.
			if (mode === 'edit') return;
			// 훑어보기: 열린 본문 위 제스처를 추적 — 탭=편집 진입, 스와이프=브라우징.
			// 캡처는 안 한다 — 캡처하면 click 이 리스트로 retarget 돼 탭 시
			// PM 포커스(모바일 키보드)가 안 뜬다.
			if (!body.classList.contains('open')) return;
			swipeY = e.clientY;
			downBarY = e.clientY;
			swiped = false;
			downBodyEdit = true;
			downBarIdx = null;
			return;
		}
		const bar = t.closest?.('.bundle-bar') as HTMLElement | null;
		if (!bar) return;
		swipeY = e.clientY;
		downBarY = e.clientY;
		swiped = false;
		downBodyEdit = false;
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
		if (!swiped && Math.abs(pe.clientY - downBarY) < 8) {
			if (downBodyEdit) {
				// 훑어보기에서 열린 본문 탭 → 편집 모드 (PM 이 이미 캐럿을 놓았다)
				mode = 'edit';
			} else if (downBarIdx !== null) {
				const now = performance.now();
				if (lastTapIdx === downBarIdx && now - lastTapTime < 300) {
					const entry = resolved[downBarIdx];
					if (entry && !entry.broken) oninternallink?.(entry.title);
					lastTapIdx = null;
				} else {
					exitEdit(); // 타이틀 클릭 = 훑어보기 복귀
					moveTo(downBarIdx);
					lastTapIdx = downBarIdx;
					lastTapTime = now;
				}
			}
		}
		swipeY = null;
		downBarIdx = null;
		downBodyEdit = false;
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
	use:direct={{ wheel: handleRootWheel }}
>
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
			{#each resolved as e, idx (e.srcIndex)}
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
					{#if e.category}
						<!-- 카테고리(상위 들여쓰기 항목 타이틀) — 우측정렬 표시 -->
						<span class="bar-category" title={e.category}>{e.category}</span>
					{/if}
					{#if idx === k && session?.termSpec && !session.termConnect}
						<!-- 터미널 노트 — 호스트 셸의 "접속" FAB 대응. 격벽이 Svelte
						     위임 click 을 죽이므로 direct 액션으로 직접 바인딩. -->
						<span
							class="bar-term-btn"
							role="button"
							tabindex="-1"
							title="SSH 접속 — {session.termSpec.target}"
							use:direct={{
								click: () => {
									setTermConnect(e.guid!, true);
									mode = 'edit';
								}
							}}
						>접속</span>
					{/if}
					{#if idx === winStart && hiddenAbove > 0}
						<span class="bar-badge">+{hiddenAbove}</span>
					{:else if idx === lastVisibleIdx && hiddenBelow > 0}
						<span class="bar-badge">+{hiddenBelow}</span>
					{/if}
				</button>
				{#if session}
					<div class="bundle-body" class:open={idx === k} use:scrollBottomInit={session.scrollBottom}>
						{#if session.termSpec && session.termConnect}
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
						{:else}
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
						{/if}
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
	/* 카테고리 — 우측정렬, 흐린 색, 길면 말줄임. 타이틀과 배지 사이. */
	.bar-category {
		flex-shrink: 1;
		min-width: 0;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: right;
		color: #9aa;
		font-size: 0.72rem;
		font-weight: 400;
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
	/* 편집 모드 — 활성 바를 한 단계 밝게 */
	.bundle-stack:not(.browse) .bundle-bar.expanded-bar {
		background: #3f8657;
	}
	.bar-term-btn {
		flex-shrink: 0;
		padding: 1px 8px;
		border-radius: 4px;
		background: #1e3a2a;
		color: #9fd4b3;
		font-size: 0.75rem;
		cursor: pointer;
	}
	.bar-term-btn:hover {
		background: #163022;
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
		transition:
			flex-grow 160ms ease-out,
			background-color 160ms ease-out;
	}
	.bundle-body.open {
		flex-grow: 1;
	}
	/* 훑어보기 모드 — 활성 본문 회색조(편집 모드의 흰 배경과 구분) + 탭 힌트.
	   touch-action: none 으로 네이티브 스크롤 대신 스와이프 브라우징을 받는다. */
	.bundle-stack.browse .bundle-body.open {
		background: #ecebe6;
		cursor: pointer;
		touch-action: none;
	}
	.bundle-term {
		height: 100%;
	}
	/* 재생 컨트롤 — 본문 스크롤 컨테이너 상단에 sticky. .music-bar 자체의
	   sticky 는 이 래퍼 박스에 갇혀 무효라 래퍼가 sticky 를 맡고, 내부 바의
	   --topnav-height 오프셋(모바일 nav 용)도 여기선 0 이어야 한다. */
	.bundle-music {
		position: sticky;
		top: 0;
		z-index: 5;
	}
	.bundle-music :global(.music-bar) {
		position: static;
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
