# 각주 미리보기(중간 단계) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각주 참조 마커를 누르면 바로 이동하던 동작에 "설명 미리보기" 중간 단계를 추가한다 — 데스크탑은 hover로 미리보기/클릭으로 이동, 모바일은 탭으로 미리보기 + 이동 버튼.

**Architecture:** 기존 데코레이션 전용 ProseMirror 플러그인(`app/src/lib/editor/footnote/`)을 유지한다. 순수 함수 `getDefinitionPreviewText`로 설명 텍스트를 추출하고, PM 비의존 DOM 컨트롤러 `FootnotePreview`가 `document.body`에 `position: fixed` 팝오버를 띄운다. `plugin.ts`의 이벤트 핸들러가 `matchMedia('(hover: none), (pointer: coarse)')`로 데스크탑/모바일을 판별해 hover(mouseover/mouseout) 또는 탭(mousedown)에 따라 미리보기/이동을 분기한다.

**Tech Stack:** SvelteKit, TipTap 3 / ProseMirror, TypeScript, vitest + @testing-library/svelte(jsdom).

설계 문서: `docs/superpowers/specs/2026-05-30-footnote-preview-design.md`

---

### Task 1: 설명 텍스트 추출 순수 함수 `getDefinitionPreviewText`

**Goal:** 설명 마커가 위치한 블록의 텍스트에서 선행 `[^label]`를 제거하고 120자 말줄임한 미리보기 문자열을 반환하는 순수 함수를 추가한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/footnotes.ts`
- Modify: `app/src/lib/editor/footnote/index.ts` (export 추가)
- Test: `app/tests/unit/editor/footnotes.test.ts`

**Acceptance Criteria:**
- [ ] `getDefinitionPreviewText(doc, defMatch)` 가 설명 단락 텍스트에서 선행 `[^label]` 토큰과 양끝 공백을 제거해 반환한다
- [ ] 선행 공백이 있는 설명(`   [^7] 설명`)도 마커를 정확히 제거한다
- [ ] 120자(기본 `maxLen`)를 넘으면 잘라내고 `…` 를 붙인다
- [ ] `index.ts` 에서 `getDefinitionPreviewText` 가 export 된다

**Verify:** `cd app && npm run test -- footnotes` → 새 테스트 포함 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 추가**

`app/tests/unit/editor/footnotes.test.ts` 의 import 에 `getDefinitionPreviewText` 를 추가:

```ts
import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText
} from '$lib/editor/footnote/footnotes.js';
```

파일 끝(마지막 `describe` 뒤)에 추가:

```ts
describe('getDefinitionPreviewText', () => {
	it('설명 마커 단락에서 선행 [^label] 와 공백을 제거한다', () => {
		const doc = makeDoc([P('제목'), P('[^7] 설명 내용')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('설명 내용');
	});

	it('선행 공백이 있는 설명도 마커를 제거한다', () => {
		const doc = makeDoc([P('제목'), P('   [^7] 띄어쓴 설명')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('띄어쓴 설명');
	});

	it('120자를 넘으면 말줄임표를 붙인다', () => {
		const long = '가'.repeat(200);
		const doc = makeDoc([P('제목'), P(`[^7] ${long}`)]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		const out = getDefinitionPreviewText(doc, def);
		expect(out.endsWith('…')).toBe(true);
		expect(out.length).toBe(121); // 120자 + …
	});

	it('짧은 설명은 그대로 반환한다', () => {
		const doc = makeDoc([P('제목'), P('[^7] 짧음')]);
		const def = findFootnoteMatches(doc).find((m) => m.isDefinitionMarker)!;
		expect(getDefinitionPreviewText(doc, def)).toBe('짧음');
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- footnotes`
Expected: FAIL — `getDefinitionPreviewText is not a function` / import 오류.

- [ ] **Step 3: 함수 구현**

`app/src/lib/editor/footnote/footnotes.ts` 파일 끝(마지막 함수 뒤)에 추가:

```ts
/**
 * 설명 마커(`defMatch`)가 위치한 textblock 의 텍스트에서 선행 `[^label]`
 * 토큰과 양끝 공백을 제거해 미리보기 문자열을 만든다. `maxLen`(기본 120)
 * 초과 시 잘라내고 `…` 를 붙인다. 순수 함수.
 */
export function getDefinitionPreviewText(
	doc: PMNode,
	defMatch: FootnoteMatch,
	maxLen = 120
): string {
	const block = doc.resolve(defMatch.from + 1).parent;
	const raw = block.textContent;
	// 선행 공백 + 첫 [^라벨] 토큰 제거.
	const stripped = raw.replace(/^\s*\[\^[^\]\s]+\]/, '').trim();
	if (stripped.length <= maxLen) return stripped;
	return stripped.slice(0, maxLen) + '…';
}
```

- [ ] **Step 4: export 추가**

`app/src/lib/editor/footnote/index.ts` 의 footnotes re-export 블록을 수정:

```ts
export {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText
} from './footnotes.js';
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npm run test -- footnotes`
Expected: PASS (기존 + 신규 모두).

- [ ] **Step 6: 커밋**

```bash
git add app/src/lib/editor/footnote/footnotes.ts app/src/lib/editor/footnote/index.ts app/tests/unit/editor/footnotes.test.ts
git commit -m "feat(footnote): getDefinitionPreviewText — 설명 미리보기 텍스트 추출"
```

---

### Task 2: 미리보기 DOM 컨트롤러 `FootnotePreview`

**Goal:** `document.body` 에 `position: fixed` 팝오버를 띄우는 PM 비의존 DOM 컨트롤러를 신규 작성한다. 모바일용 "이동" 버튼, missing 안내 상태, 바깥 탭/스크롤 자동 닫힘을 포함한다.

**Files:**
- Create: `app/src/lib/editor/footnote/preview.ts`
- Test: `app/tests/unit/editor/footnotePreview.test.ts`

**Acceptance Criteria:**
- [ ] `show()` 가 `.tomboy-fn-preview` 요소를 `document.body` 에 추가하고 텍스트를 표시한다
- [ ] `withJumpButton: true` 면 `.tomboy-fn-preview-jump` 버튼이 렌더되고, 클릭 시 `onJump` 호출 + 요소 제거
- [ ] `withJumpButton: false` 면 버튼이 없고 `.tomboy-fn-preview-static` 클래스가 붙는다
- [ ] `missing: true` 면 `.tomboy-fn-preview-missing` 클래스가 붙고 버튼이 없다
- [ ] `hide()` 가 요소를 제거한다. `show()` 재호출 시 이전 요소를 먼저 제거한다
- [ ] 모바일(`withJumpButton: true`)에서 바깥 `pointerdown` 시 자동으로 닫힌다

**Verify:** `cd app && npm run test -- footnotePreview` → 전부 PASS

**Steps:**

- [ ] **Step 1: 실패하는 테스트 작성**

`app/tests/unit/editor/footnotePreview.test.ts` 생성:

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { FootnotePreview } from '$lib/editor/footnote/preview.js';

let preview: FootnotePreview;
let anchor: HTMLElement;

beforeEach(() => {
	preview = new FootnotePreview();
	anchor = document.createElement('span');
	document.body.appendChild(anchor);
});

afterEach(() => {
	preview.hide();
	anchor.remove();
	document
		.querySelectorAll('.tomboy-fn-preview')
		.forEach((el) => el.remove());
	vi.useRealTimers();
});

describe('FootnotePreview', () => {
	it('show 가 본문 텍스트를 가진 팝오버를 document.body 에 추가한다', () => {
		preview.show(anchor, '설명 내용', { withJumpButton: false });
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.textContent).toContain('설명 내용');
	});

	it('withJumpButton:false 면 버튼이 없고 static 클래스가 붙는다', () => {
		preview.show(anchor, '설명', { withJumpButton: false });
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
		expect(
			document
				.querySelector('.tomboy-fn-preview')!
				.classList.contains('tomboy-fn-preview-static')
		).toBe(true);
	});

	it('withJumpButton:true 면 이동 버튼 클릭이 onJump 를 부르고 팝오버를 닫는다', () => {
		const onJump = vi.fn();
		preview.show(anchor, '설명', { withJumpButton: true, onJump });
		const btn = document.querySelector(
			'.tomboy-fn-preview-jump'
		) as HTMLButtonElement;
		expect(btn).not.toBeNull();
		btn.click();
		expect(onJump).toHaveBeenCalledOnce();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});

	it('missing:true 면 missing 클래스가 붙고 버튼이 없다', () => {
		preview.show(anchor, '설명을 찾을 수 없습니다', {
			withJumpButton: true,
			missing: true
		});
		const el = document.querySelector('.tomboy-fn-preview')!;
		expect(el.classList.contains('tomboy-fn-preview-missing')).toBe(true);
		expect(document.querySelector('.tomboy-fn-preview-jump')).toBeNull();
	});

	it('hide 가 요소를 제거하고, show 재호출이 이전 요소를 치운다', () => {
		preview.show(anchor, '첫 번째', { withJumpButton: false });
		preview.show(anchor, '두 번째', { withJumpButton: false });
		expect(document.querySelectorAll('.tomboy-fn-preview')).toHaveLength(1);
		expect(document.querySelector('.tomboy-fn-preview')!.textContent).toContain(
			'두 번째'
		);
		preview.hide();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});

	it('모바일 팝오버는 바깥 pointerdown 에 닫힌다', () => {
		vi.useFakeTimers();
		preview.show(anchor, '설명', { withJumpButton: true, onJump: () => {} });
		vi.runAllTimers(); // 닫힘 리스너 등록(0ms setTimeout)
		document.body.dispatchEvent(
			new Event('pointerdown', { bubbles: true })
		);
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- footnotePreview`
Expected: FAIL — `Cannot find module '$lib/editor/footnote/preview.js'`.

- [ ] **Step 3: 컨트롤러 구현**

`app/src/lib/editor/footnote/preview.ts` 생성:

```ts
/**
 * 각주 미리보기 팝오버 — PM 비의존 순수 DOM 컨트롤러.
 *
 * document.body 에 position: fixed 요소를 붙여(에디터 overflow 클리핑 회피)
 * 마커 위(공간 부족 시 아래)에 띄운다. 데스크탑 hover 는 버튼 없는 표시용
 * (withJumpButton:false → pointer-events:none), 모바일 탭은 "이동" 버튼 포함.
 * 모바일 표시 중에는 바깥 pointerdown / scroll 시 자동으로 닫는다.
 */
export interface FootnotePreviewShowOptions {
	/** 모바일: "이동" 버튼을 렌더하고 인터랙티브하게 만든다. */
	withJumpButton: boolean;
	/** 설명을 찾지 못한 안내 상태(버튼 숨김). */
	missing?: boolean;
	/** 이동 버튼 클릭 시 호출(클릭 시 팝오버는 먼저 닫힌다). */
	onJump?: () => void;
}

export class FootnotePreview {
	private el: HTMLElement | null = null;
	private dismissHandler: ((ev: Event) => void) | null = null;

	show(
		anchorEl: HTMLElement,
		text: string,
		opts: FootnotePreviewShowOptions
	): void {
		this.hide();

		const el = document.createElement('div');
		el.className = 'tomboy-fn-preview';
		if (opts.missing) el.classList.add('tomboy-fn-preview-missing');
		if (!opts.withJumpButton) el.classList.add('tomboy-fn-preview-static');

		const body = document.createElement('div');
		body.className = 'tomboy-fn-preview-text';
		body.textContent = text;
		el.appendChild(body);

		if (opts.withJumpButton && !opts.missing) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'tomboy-fn-preview-jump';
			btn.textContent = '이동';
			btn.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const jump = opts.onJump;
				this.hide();
				jump?.();
			});
			el.appendChild(btn);
		}

		document.body.appendChild(el);
		this.el = el;
		this.position(anchorEl);

		if (opts.withJumpButton) {
			// 모바일: 바깥 탭/스크롤 시 닫기. 현재 mousedown 이벤트 루프를
			// 건너뛰도록 0ms 지연 후 등록(즉시 닫힘 방지).
			const handler = (ev: Event) => {
				if (ev.target instanceof Node && el.contains(ev.target)) return;
				this.hide();
			};
			this.dismissHandler = handler;
			window.setTimeout(() => {
				if (this.dismissHandler !== handler) return;
				document.addEventListener('pointerdown', handler, true);
				window.addEventListener('scroll', handler, true);
			}, 0);
		}
	}

	hide(): void {
		if (this.dismissHandler) {
			document.removeEventListener('pointerdown', this.dismissHandler, true);
			window.removeEventListener('scroll', this.dismissHandler, true);
			this.dismissHandler = null;
		}
		if (this.el) {
			this.el.remove();
			this.el = null;
		}
	}

	/** 마커 기준 위쪽 배치(공간 부족 시 아래), 화면 밖으로 나가지 않게 보정. */
	private position(anchorEl: HTMLElement): void {
		const el = this.el;
		if (!el) return;
		const rect = anchorEl.getBoundingClientRect();
		const margin = 8;
		const elRect = el.getBoundingClientRect();
		let top = rect.top - elRect.height - margin;
		if (top < margin) top = rect.bottom + margin;
		let left = rect.left;
		const maxLeft = window.innerWidth - elRect.width - margin;
		if (left > maxLeft) left = Math.max(margin, maxLeft);
		el.style.top = `${Math.round(top)}px`;
		el.style.left = `${Math.round(left)}px`;
	}
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app && npm run test -- footnotePreview`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/footnote/preview.ts app/tests/unit/editor/footnotePreview.test.ts
git commit -m "feat(footnote): FootnotePreview — 미리보기 팝오버 DOM 컨트롤러"
```

---

### Task 3: 플러그인 이벤트 배선 — hover/탭 분기 + 미리보기 통합

**Goal:** `plugin.ts` 에 데스크탑/모바일 판별을 추가하고, 참조 마커는 데스크탑 hover→미리보기 / 클릭→이동, 모바일 탭→미리보기+이동 버튼으로 분기한다. 설명 마커는 양쪽 모두 즉시 이동. 플러그인 파괴 시 미리보기를 정리한다.

**Files:**
- Modify: `app/src/lib/editor/footnote/plugin.ts`
- Test: `app/tests/unit/editor/footnotePlugin.test.ts`

**Acceptance Criteria:**
- [ ] 데스크탑(matchMedia 폴백)에서 참조 mousedown 은 기존대로 짝으로 이동 / 짝 없으면 `onMissing` 호출 (기존 테스트 보존)
- [ ] 모바일(matchMedia mock)에서 참조 mousedown 은 이동하지 않고 `.tomboy-fn-preview` + `.tomboy-fn-preview-jump` 를 띄운다
- [ ] 모바일에서 이동 버튼 클릭이 `scrollIntoView` 를 트리거한다
- [ ] 모바일에서 짝 없는 참조 탭은 `.tomboy-fn-preview-missing` 안내를 띄우고 `onMissing` 을 호출하지 않는다
- [ ] 설명 마커 mousedown 은 데스크탑/모바일 모두 즉시 이동(미리보기 없음)

**Verify:** `cd app && npm run test -- footnotePlugin` → 전부 PASS. 추가로 `cd app && npm run check` 타입 통과.

**Steps:**

- [ ] **Step 1: 모바일 분기 테스트 추가(실패 확인용)**

`app/tests/unit/editor/footnotePlugin.test.ts` 상단 import 아래(예: `afterEach` 다음)에 matchMedia 헬퍼 추가:

```ts
function mockTouch(isTouch: boolean): void {
	// @ts-expect-error jsdom 은 matchMedia 를 구현하지 않는다.
	window.matchMedia = (q: string) => ({
		matches: isTouch,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false
	});
}
```

기존 `afterEach` 를 확장해 matchMedia 와 잔여 팝오버를 정리:

```ts
afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
	// @ts-expect-error 테스트 간 격리.
	delete window.matchMedia;
	document
		.querySelectorAll('.tomboy-fn-preview')
		.forEach((el) => el.remove());
});
```

파일 끝에 새 describe 추가:

```ts
describe('footnote plugin 모바일 미리보기', () => {
	it('참조 탭은 이동하지 않고 이동 버튼이 있는 미리보기를 띄운다', () => {
		mockTouch(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([P('제목'), P('본문 [^7]'), P('[^7] 라벨7 설명')]);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		// 탭만으로는 이동하지 않음.
		expect(scroll).not.toHaveBeenCalled();
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.textContent).toContain('라벨7 설명');
		// 이동 버튼 클릭 → 이동.
		(document.querySelector('.tomboy-fn-preview-jump') as HTMLButtonElement).click();
		expect(scroll).toHaveBeenCalled();
		scroll.mockRestore();
	});

	it('짝 없는 참조 탭은 안내 미리보기를 띄우고 onMissing 을 부르지 않는다', () => {
		mockTouch(true);
		const onMissing = vi.fn();
		const e = makeEditor([P('제목'), P('본문 [^7]')], onMissing);
		tapFootnote(e, 'sup.tomboy-fn-ref');
		const el = document.querySelector('.tomboy-fn-preview');
		expect(el).not.toBeNull();
		expect(el!.classList.contains('tomboy-fn-preview-missing')).toBe(true);
		expect(onMissing).not.toHaveBeenCalled();
	});

	it('설명 마커 탭은 모바일에서도 미리보기 없이 즉시 이동한다', () => {
		mockTouch(true);
		const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
		const e = makeEditor([P('제목'), P('본문 [^7]'), P('[^7] 설명')]);
		tapFootnote(e, '.tomboy-fn-def');
		expect(scroll).toHaveBeenCalled();
		expect(document.querySelector('.tomboy-fn-preview')).toBeNull();
		scroll.mockRestore();
	});
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app && npm run test -- footnotePlugin`
Expected: FAIL — 모바일 참조 탭이 (아직 미구현이라) 이동하거나 미리보기가 안 뜸.

- [ ] **Step 3: `plugin.ts` import 및 헬퍼 추가**

`app/src/lib/editor/footnote/plugin.ts` 의 footnotes import 에 `getDefinitionPreviewText` 추가하고 preview import 추가:

```ts
import {
	findFootnoteMatches,
	findFootnoteAt,
	findFootnotePartner,
	getDefinitionPreviewText,
	type FootnoteMatch
} from './footnotes.js';
import { FootnotePreview } from './preview.js';
```

`scrollToMatch` 함수 정의 아래(파일 모듈 스코프)에 판별 헬퍼 추가:

```ts
/** 터치/호버 불가 환경(모바일)이면 true. matchMedia 미지원 시 데스크탑으로 폴백. */
function isTouchDevice(): boolean {
	try {
		return (
			typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(hover: none), (pointer: coarse)').matches
		);
	} catch {
		return false;
	}
}

/** 각주 DOM 요소에 대응하는 매치를 찾는다(없으면 null). */
function footnoteHitFor(
	view: EditorView,
	matches: FootnoteMatch[],
	fnEl: HTMLElement
): FootnoteMatch | null {
	let pos: number | null = null;
	try {
		pos = view.posAtDOM(fnEl, 0);
	} catch {
		pos = null;
	}
	return pos != null ? findFootnoteAt(matches, pos) : null;
}
```

- [ ] **Step 4: `createFootnotePlugin` 본문 재작성**

`createFootnotePlugin` 의 `return new Plugin(...)` 직전에 인스턴스/클로저를 만들고, `props` 의 `handleDOMEvents` 를 교체하며 `view` 정리 훅을 추가한다. 함수 전체를 아래로 교체:

```ts
export function createFootnotePlugin(
	options: FootnotePluginOptions
): Plugin<FootnotePluginState> {
	const preview = new FootnotePreview();
	let hoverTimer: number | null = null;
	const clearHoverTimer = () => {
		if (hoverTimer != null) {
			window.clearTimeout(hoverTimer);
			hoverTimer = null;
		}
	};

	// 짝으로 이동(없으면 onMissing). 데스크탑 클릭/설명 마커 공용.
	const jumpToPartner = (view: EditorView, hit: FootnoteMatch) => {
		preview.hide();
		const st = footnotePluginKey.getState(view.state);
		if (!st) return;
		const partner = findFootnotePartner(st.matches, hit);
		if (partner) {
			scrollToMatch(view, partner);
		} else {
			options.onMissing(
				hit.label,
				hit.isDefinitionMarker ? 'definition' : 'reference'
			);
		}
	};

	// 참조 마커의 설명 미리보기 표시(짝 없으면 안내 문구).
	const showRefPreview = (
		view: EditorView,
		anchorEl: HTMLElement,
		hit: FootnoteMatch,
		withJumpButton: boolean
	) => {
		const st = footnotePluginKey.getState(view.state);
		if (!st) return;
		const partner = findFootnotePartner(st.matches, hit);
		if (partner) {
			const text = getDefinitionPreviewText(view.state.doc, partner);
			preview.show(anchorEl, text, {
				withJumpButton,
				onJump: () => scrollToMatch(view, partner)
			});
		} else {
			preview.show(anchorEl, '설명을 찾을 수 없습니다', {
				withJumpButton,
				missing: true
			});
		}
	};

	return new Plugin<FootnotePluginState>({
		key: footnotePluginKey,
		state: {
			init(_, state) {
				const matches = findFootnoteMatches(state.doc);
				return {
					matches,
					decorations: buildDecorations(state.doc, matches)
				};
			},
			apply(tr, prev, _old, newState) {
				if (!tr.docChanged) return prev;
				const matches = findFootnoteMatches(newState.doc);
				return {
					matches,
					decorations: buildDecorations(newState.doc, matches)
				};
			}
		},
		view() {
			return {
				destroy() {
					clearHoverTimer();
					preview.hide();
				}
			};
		},
		props: {
			decorations(state) {
				return footnotePluginKey.getState(state)?.decorations ?? null;
			},
			handleDOMEvents: {
				// 탭/클릭은 mousedown 단계에서 처리한다. preventDefault 로
				// 에디터 포커스/캐럿 이동을 막아(모바일 키보드 방지) true 반환.
				mousedown(view, event) {
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref, .tomboy-fn-def')
							: null;
					if (!(fnEl instanceof HTMLElement)) return false;
					event.preventDefault();
					const st = footnotePluginKey.getState(view.state);
					if (!st) return true;
					const hit = footnoteHitFor(view, st.matches, fnEl);
					if (!hit) return true;
					// 설명 마커: 양쪽 플랫폼 모두 즉시 이동.
					if (hit.isDefinitionMarker) {
						jumpToPartner(view, hit);
						return true;
					}
					// 참조 마커: 모바일은 미리보기, 데스크탑은 즉시 이동.
					if (isTouchDevice()) {
						showRefPreview(view, fnEl, hit, true);
					} else {
						jumpToPartner(view, hit);
					}
					return true;
				},
				// 데스크탑 hover: 참조 마커 위에서 미리보기(표시 전용).
				mouseover(view, event) {
					if (isTouchDevice()) return false;
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref')
							: null;
					if (!(fnEl instanceof HTMLElement)) return false;
					const st = footnotePluginKey.getState(view.state);
					if (!st) return false;
					const hit = footnoteHitFor(view, st.matches, fnEl);
					if (!hit || hit.isDefinitionMarker) return false;
					clearHoverTimer();
					hoverTimer = window.setTimeout(() => {
						hoverTimer = null;
						showRefPreview(view, fnEl, hit, false);
					}, 120);
					return false;
				},
				mouseout(view, event) {
					if (isTouchDevice()) return false;
					const target = event.target;
					const fnEl =
						target instanceof Element
							? target.closest('.tomboy-fn-ref')
							: null;
					if (!fnEl) return false;
					const related = event.relatedTarget;
					// 같은 마커 내부 이동이면 무시.
					if (related instanceof Node && fnEl.contains(related)) {
						return false;
					}
					clearHoverTimer();
					preview.hide();
					return false;
				}
			}
		}
	});
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd app && npm run test -- footnotePlugin`
Expected: PASS — 기존 데스크탑 테스트 + 신규 모바일 테스트 모두.

- [ ] **Step 6: 타입 체크**

Run: `cd app && npm run check`
Expected: 신규/수정 파일에서 타입 오류 없음.

- [ ] **Step 7: 커밋**

```bash
git add app/src/lib/editor/footnote/plugin.ts app/tests/unit/editor/footnotePlugin.test.ts
git commit -m "feat(footnote): hover/탭 미리보기 중간단계 — 플러그인 이벤트 분기"
```

---

### Task 4: 미리보기 팝오버 스타일

**Goal:** `TomboyEditor.svelte` 에 미리보기 팝오버의 전역 CSS 를 추가한다. 데스크탑(static) 변형은 `pointer-events: none`, 모바일은 "이동" 버튼 스타일, missing 은 회색 톤.

**Files:**
- Modify: `app/src/lib/editor/TomboyEditor.svelte` (기존 각주 CSS ~1821-1852 인근의 `<style>` 블록)

**Acceptance Criteria:**
- [ ] `.tomboy-fn-preview` 가 `position: fixed`, 흰 배경, 테두리/그림자/둥근 모서리, `z-index < 1000`(토스트 아래)로 정의된다
- [ ] `.tomboy-fn-preview-static` 은 `pointer-events: none`
- [ ] `.tomboy-fn-preview-jump` 버튼 스타일과 `.tomboy-fn-preview-missing` 회색 톤이 정의된다
- [ ] `npm run check` 통과, `npm run build` 성공

**Verify:** `cd app && npm run check && npm run build` → 오류 없음. 이후 `npm run dev` 로 데스크탑 hover / 모바일 에뮬레이션 탭 수동 확인.

**Steps:**

- [ ] **Step 1: 기존 각주 flash 애니메이션 위치 확인**

`app/src/lib/editor/TomboyEditor.svelte` 에서 `tomboy-fn-flash` keyframes 블록(약 1842-1852행)을 찾는다. 이 블록 바로 뒤에 미리보기 CSS 를 추가한다.

- [ ] **Step 2: 미리보기 CSS 추가**

`@keyframes -global-tomboy-fn-flash { ... }` 블록 다음에 추가:

```css
	/* 각주 미리보기 팝오버 — document.body 에 붙어 전역 클래스로 스타일. */
	:global(.tomboy-fn-preview) {
		position: fixed;
		z-index: 900;
		max-width: 300px;
		padding: 0.5rem 0.625rem;
		background: #ffffff;
		border: 1px solid #d1d5db;
		border-radius: 0.5rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		font-size: 0.8125rem;
		line-height: 1.4;
		color: #1f2937;
	}
	:global(.tomboy-fn-preview-static) {
		pointer-events: none;
	}
	:global(.tomboy-fn-preview-text) {
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
		white-space: pre-wrap;
		word-break: break-word;
	}
	:global(.tomboy-fn-preview-missing) {
		color: #6b7280;
		font-style: italic;
	}
	:global(.tomboy-fn-preview-jump) {
		display: inline-block;
		margin-top: 0.4rem;
		padding: 0.25rem 0.6rem;
		font-size: 0.8125rem;
		color: #ffffff;
		background: #2563eb;
		border: none;
		border-radius: 0.375rem;
		cursor: pointer;
	}
```

- [ ] **Step 3: 타입/빌드 확인**

Run: `cd app && npm run check && npm run build`
Expected: 오류 없이 완료.

- [ ] **Step 4: 수동 확인(권장)**

Run: `cd app && npm run dev`
- 데스크탑: 참조 위첨자에 마우스 hover → 설명 미리보기 팝오버, 마우스 떼면 사라짐. 참조 클릭 → 설명으로 이동. 설명 마커 클릭 → 참조로 이동.
- 모바일 에뮬레이션(DevTools device toolbar): 참조 탭 → 미리보기 + "이동" 버튼. 버튼 탭 → 이동. 바깥 탭 → 닫힘. 설명 마커 탭 → 즉시 이동.

- [ ] **Step 5: 커밋**

```bash
git add app/src/lib/editor/TomboyEditor.svelte
git commit -m "feat(footnote): 각주 미리보기 팝오버 스타일"
```

---

## Self-Review

- **Spec coverage:** 동작 매트릭스 전 행(참조 데스크탑 hover/클릭, 참조 모바일 탭/이동버튼/바깥탭, 설명 양쪽 이동, missing 안내)이 Task 1(텍스트 추출) + Task 2(팝오버/버튼/missing/바깥닫힘) + Task 3(분기/hover/정리) + Task 4(스타일)로 모두 커버됨. matchMedia 폴백 보존 = Task 3 AC. `document.body` fixed 배치 = Task 2. 120자 말줄임 = Task 1.
- **Placeholder scan:** 모든 코드 스텝에 실제 코드/명령/기대 출력 포함, TBD/TODO 없음.
- **Type consistency:** `FootnotePreviewShowOptions`(withJumpButton/missing/onJump), `getDefinitionPreviewText(doc, defMatch, maxLen)`, `footnoteHitFor(view, matches, fnEl)`, `isTouchDevice()`, `showRefPreview`/`jumpToPartner` 시그니처가 Task 2/3 간 일치. 클래스명(`.tomboy-fn-preview`, `-static`, `-text`, `-missing`, `-jump`)이 Task 2/3/4 간 일치.
