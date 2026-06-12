/**
 * 노트 묶음 ProseMirror 플러그인.
 *
 * - 체크된 번들: 링크 리스트에 .tomboy-note-bundle-hidden 노드 데코레이션
 *   + 리스트 끝(리스트 없으면 키워드 끝)에 위젯 → mountStack 콜백으로
 *   Svelte 스택 마운트. 순수 뷰 레이어, XML 무변경 (geoMap 패턴).
 * - 라디오 의무: 체크된 번들에 라디오 없는 링크 항목이 보이면 microtask
 *   에서 자동 삽입 tr 디스패치 (멱등 — 삽입 후엔 missing 이 없다).
 * - 위젯 컨테이너는 ordinal 키로 캐시 — 호스트 타이핑마다 스택이
 *   리마운트되지 않는다. spec 변경은 StackController.update 로 전달.
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseNoteBundles, clampHeightPct, type BundleSpec } from './parser.js';

export interface StackController {
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
		if (b.listPos !== null && b.listEnd !== null && b.entries.length > 0) {
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
	let insertScheduled = false;

	const syncControllers = (view: EditorView) => {
		const st = noteBundlePluginKey.getState(view.state);
		if (!st) return;
		const active = new Set<number>();
		for (const b of st.bundles) {
			if (!b.checked) continue;
			active.add(b.ordinal);
			const existing = controllers.get(b.ordinal);
			if (existing) {
				existing.update(b);
			} else {
				const el = containers.get(b.ordinal);
				if (el && el.isConnected) {
					controllers.set(b.ordinal, opts.mountStack(el, view, b));
				}
			}
		}
		for (const [ord, ctrl] of [...controllers]) {
			if (!active.has(ord)) {
				ctrl.destroy();
				controllers.delete(ord);
				containers.delete(ord);
			}
		}
	};

	const scheduleRadioInsert = (view: EditorView) => {
		if (insertScheduled) return;
		const st = noteBundlePluginKey.getState(view.state);
		if (!st) return;
		const needs = st.bundles.some(
			(b) => b.checked && b.entries.some((e) => e.radioPos === null)
		);
		if (!needs) return;
		insertScheduled = true;
		// microtask 로 미루는 이유: 플러그인 view.update 안에서 dispatch 금지.
		queueMicrotask(() => {
			insertScheduled = false;
			if (view.isDestroyed) return;
			// 신선한 state 에서 재계산 — 사이 편집으로 pos 가 밀려도 안전.
			const cur = noteBundlePluginKey.getState(view.state);
			const radioType = view.state.schema.nodes.inlineRadio;
			if (!cur || !radioType) return;
			const tr = view.state.tr;
			let changed = false;
			for (const b of cur.bundles) {
				if (!b.checked) continue;
				const missing = b.entries.filter((e) => e.radioPos === null);
				if (missing.length === 0) continue;
				const hasSelected = b.entries.some((e) => e.selected);
				const firstEntry = b.entries[0];
				// 뒤에서 앞으로 삽입 — 앞 위치가 밀리지 않게.
				const sorted = [...missing].sort((a, z) => z.itemTextFrom - a.itemTextFrom);
				for (const e of sorted) {
					const makeSelected = !hasSelected && e === firstEntry;
					tr.insert(e.itemTextFrom, radioType.create({ selected: makeSelected }));
					changed = true;
				}
				// 첫 항목에 기존 라디오가 있는데 아무것도 선택 안 됨 → 첫 라디오 (o).
				// (삽입은 전부 뒤쪽 항목 — firstEntry.radioPos 는 밀리지 않는다.)
				if (!hasSelected && firstEntry && firstEntry.radioPos !== null) {
					tr.setNodeAttribute(firstEntry.radioPos, 'selected', true);
					changed = true;
				}
			}
			if (changed) view.dispatch(tr);
		});
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
				scheduleRadioInsert(view);
			});
			return {
				update(v) {
					syncControllers(v);
					scheduleRadioInsert(v);
				},
				destroy() {
					for (const c of controllers.values()) c.destroy();
					controllers.clear();
					containers.clear();
				}
			};
		}
	});
}

/** 스크롤/바 클릭 → 펼침 항목 변경. 라디오 상호 배타 tr 디스패치. */
export function selectBundleEntry(view: EditorView, bundle: BundleSpec, index: number): void {
	const tr = view.state.tr;
	bundle.entries.forEach((e, i) => {
		if (e.radioPos === null) return;
		const want = i === index;
		if (e.selected !== want) tr.setNodeAttribute(e.radioPos, 'selected', want);
	});
	if (tr.steps.length > 0) view.dispatch(tr);
}

/** 드래그 리사이즈 종료 → `:N` 텍스트 영구화. */
export function writeBundleHeightPct(view: EditorView, bundle: BundleSpec, pct: number): void {
	const clamped = clampHeightPct(pct);
	if (clamped === bundle.heightPct) return;
	view.dispatch(view.state.tr.insertText(String(clamped), bundle.digitsFrom, bundle.digitsTo));
}
