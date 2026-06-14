/**
 * 묶음 ProseMirror 플러그인.
 *
 * - 체크된 번들: 선언 라인(체크박스 키워드 paragraph) + 링크 리스트에
 *   .tomboy-note-bundle-hidden 노드 데코레이션(공간 절약) + 리스트 끝(리스트
 *   없으면 키워드 끝)에 위젯 → mountStack 콜백으로 Svelte 스택 마운트. 순수
 *   뷰 레이어, XML 무변경 (geoMap 패턴). 다시 편집은 setBundleChecked(false).
 * - 위젯 컨테이너는 ordinal 키로 캐시 — 호스트 타이핑마다 스택이
 *   리마운트되지 않는다. spec 변경은 StackController.update 로 전달.
 *
 * 활성 노트 선택은 영속하지 않으므로(컴포넌트 로컬 상태) 플러그인은 리스트
 * 내용을 수정하지 않는다 — 라디오 자동삽입/선택 쓰기백 없음. 높이(`:N`)만
 * writeBundleHeightPct 로 영속한다(키워드 라인 텍스트, 리스트 밖).
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseNoteBundles, clampHeightPct, type BundleSpec, type BundleKind } from './parser.js';

/** 번들에 펼칠 콘텐츠가 있나 — kind 무관(탭=tree, 묶음=entries). */
function hasContent(b: BundleSpec): boolean {
	return b.tree.length > 0 || b.entries.length > 0;
}

export interface StackController {
	/** spec 전체 교체로 취급할 것. 번들 삭제로 ordinal 이 재배정되면 같은
	 *  컨트롤러가 '다른 번들'의 spec 을 받을 수 있다 — 컴포넌트는 이전
	 *  spec 과의 차분이 아니라 새 spec 에서 모든 상태를 파생해야 한다. */
	update(spec: BundleSpec): void;
	destroy(): void;
}

export interface NoteBundleOptions {
	mountStack(container: HTMLElement, view: EditorView, spec: BundleSpec): StackController;
}

interface PluginState {
	bundles: BundleSpec[];
	decorations: DecorationSet;
}

export const noteBundlePluginKey = new PluginKey<PluginState>('tomboyNoteBundle');

function buildState(doc: PMNode, containers: Map<number, HTMLElement>): PluginState {
	const bundles = parseNoteBundles(doc);
	const decos: Decoration[] = [];
	for (const b of bundles) {
		if (!b.checked) continue;
		// 체크 시 선언 라인(체크박스 + 키워드 paragraph)도 숨겨 공간 절약 —
		// 다시 편집하려면 Ctrl 누르고 스택 우상단 편집 버튼(체크 해제).
		decos.push(
			Decoration.node(b.keywordPos, b.keywordEnd, { class: 'tomboy-note-bundle-hidden' })
		);
		if (b.listPos !== null && b.listEnd !== null && hasContent(b)) {
			decos.push(
				Decoration.node(b.listPos, b.listEnd, { class: 'tomboy-note-bundle-hidden' })
			);
		}
		const widgetPos = b.listEnd ?? b.keywordEnd;
		decos.push(
			Decoration.widget(
				widgetPos,
				() => {
					// 같은 ordinal 은 항상 같은 엘리먼트 — PM 이 toDOM 을 다시
					// 불러도 마운트된 Svelte 컴포넌트가 보존된다.
					let el = containers.get(b.ordinal);
					if (el) return el;
					el = document.createElement('div');
					el.className = 'tomboy-note-bundle';
					el.setAttribute('contenteditable', 'false');
					containers.set(b.ordinal, el);
					return el;
				},
				{ key: `note-bundle-${b.ordinal}`, side: 1 }
			)
		);
	}
	return {
		bundles,
		decorations: decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
	};
}

export function createNoteBundlePlugin(opts: NoteBundleOptions): Plugin<PluginState> {
	const containers = new Map<number, HTMLElement>();
	const controllers = new Map<number, StackController>();
	// 컨트롤러가 어떤 kind 로 마운트됐는지 — ordinal 재배정/키워드 편집으로
	// 같은 ordinal 의 kind 가 바뀌면(탭↔묶음) 컴포넌트를 교체해야 한다.
	const controllerKind = new Map<number, BundleKind>();

	const syncControllers = (view: EditorView) => {
		const st = noteBundlePluginKey.getState(view.state);
		if (!st) return;
		const active = new Set<number>();
		for (const b of st.bundles) {
			if (!b.checked) continue;
			active.add(b.ordinal);
			const existing = controllers.get(b.ordinal);
			if (existing && controllerKind.get(b.ordinal) === b.kind) {
				existing.update(b);
				continue;
			}
			if (existing) {
				// kind 변경(탭↔묶음) — update 로는 컴포넌트를 못 바꾸므로 파괴 후
				// 같은 컨테이너에 새 컴포넌트를 리마운트.
				existing.destroy();
				controllers.delete(b.ordinal);
				controllerKind.delete(b.ordinal);
			}
			const el = containers.get(b.ordinal);
			if (el && el.isConnected) {
				controllers.set(b.ordinal, opts.mountStack(el, view, b));
				controllerKind.set(b.ordinal, b.kind);
			}
		}
		for (const [ord, ctrl] of [...controllers]) {
			if (!active.has(ord)) {
				ctrl.destroy();
				controllers.delete(ord);
				controllerKind.delete(ord);
				containers.delete(ord);
			}
		}
	};

	return new Plugin<PluginState>({
		key: noteBundlePluginKey,
		state: {
			init: (_, s) => buildState(s.doc, containers),
			apply(tr, old) {
				if (!tr.docChanged) return old;
				return buildState(tr.doc, containers);
			}
		},
		props: {
			decorations(state) {
				return noteBundlePluginKey.getState(state)?.decorations;
			}
		},
		view(view) {
			// XML 로드 직후에도 체크된 번들이 있을 수 있다 — 초기 1회 sync.
			// (위젯 DOM 이 붙은 뒤여야 하므로 microtask 로 미룬다.)
			queueMicrotask(() => {
				if (view.isDestroyed) return;
				syncControllers(view);
			});
			return {
				update(v) {
					syncControllers(v);
				},
				destroy() {
					for (const c of controllers.values()) c.destroy();
					controllers.clear();
					controllerKind.clear();
					containers.clear();
				}
			};
		}
	});
}

/** 드래그 리사이즈 종료 → `:N` 텍스트 영구화. ordinal 로 신선한 번들 재조회.
 *  (리스트 내용이 아니라 키워드 라인의 높이 숫자만 건드린다.) */
export function writeBundleHeightPct(view: EditorView, ordinal: number, pct: number): void {
	const bundle = noteBundlePluginKey
		.getState(view.state)
		?.bundles.find((b) => b.ordinal === ordinal);
	if (!bundle) return;
	const clamped = clampHeightPct(pct);
	if (clamped === bundle.heightPct) return;
	view.dispatch(view.state.tr.insertText(String(clamped), bundle.digitsFrom, bundle.digitsTo));
}

/** 번들 체크박스 attr 토글. ordinal 로 신선한 번들 재조회 → 체크박스 atom 의
 *  `checked` 설정. 스택 우상단 편집 버튼이 false 로 호출 → 선언 라인 + 리스트
 *  다시 보임(데코 해제) + 위젯 파괴(컨트롤러). 변화 없으면 no-op. */
export function setBundleChecked(view: EditorView, ordinal: number, checked: boolean): void {
	const bundle = noteBundlePluginKey
		.getState(view.state)
		?.bundles.find((b) => b.ordinal === ordinal);
	if (!bundle || bundle.checked === checked) return;
	const node = view.state.doc.nodeAt(bundle.checkboxPos);
	if (!node || node.type.name !== 'inlineCheckbox') return;
	view.dispatch(view.state.tr.setNodeAttribute(bundle.checkboxPos, 'checked', checked));
}
