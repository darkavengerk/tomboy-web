/**
 * ProseMirror plugin that finds `geo:lat,lon` URLs in the doc and renders
 * an inline Leaflet map widget below each one. Mirrors the structure of
 * `imagePreviewPlugin` (scan → decoration → atomic-character key handling).
 *
 * Unlike the image plugin, we do NOT hide the URL text — the coordinates
 * are meaningful information the user reads.
 *
 * Invariant: the document itself is NEVER modified by rendering. The URL
 * stays in the doc verbatim so the Tomboy `.note` XML round-trip is stable.
 */

import {
	Plugin,
	PluginKey,
	TextSelection,
	type EditorState,
	type Transaction
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseGeoUrl, type GeoCoords } from './parseGeoUrl.js';
import { mountGeoMap, type GeoMapInstance } from './renderGeoMap.js';

export const geoMapPluginKey = new PluginKey<PluginState>('tomboyGeoMap');

export interface GeoUrlRange {
	from: number;
	to: number;
	href: string;
	coords: GeoCoords;
}

interface PluginState {
	decorations: DecorationSet;
	ranges: GeoUrlRange[];
}

const GEO_URL_RE = /geo:[^\s<>"']+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]\}>]+$/;

export function findGeoUrlRanges(doc: PMNode): GeoUrlRange[] {
	const out: GeoUrlRange[] = [];

	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		const text = node.text;
		GEO_URL_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = GEO_URL_RE.exec(text)) !== null) {
			let url = m[0];
			while (true) {
				const trimmed = url.replace(TRAILING_PUNCT_RE, '');
				if (trimmed === url) break;
				url = trimmed;
			}
			const coords = parseGeoUrl(url);
			if (!coords) continue;
			const startInText = m.index;
			const endInText = startInText + url.length;
			out.push({
				from: pos + startInText,
				to: pos + endInText,
				href: url,
				coords
			});
		}
	});

	return out;
}

function buildState(doc: PMNode): PluginState {
	const ranges = findGeoUrlRanges(doc);
	if (ranges.length === 0) {
		return { decorations: DecorationSet.empty, ranges };
	}

	const decos: Decoration[] = [];
	for (const r of ranges) {
		decos.push(
			Decoration.widget(r.to, () => renderGeoMapWidget(r), {
				side: 1,
				key: `geo:${r.from}:${r.to}:${r.href}`
			})
		);
	}
	return { decorations: DecorationSet.create(doc, decos), ranges };
}

function renderGeoMapWidget(range: GeoUrlRange): HTMLElement {
	const container = document.createElement('div');
	container.className = 'tomboy-geo-map';
	container.setAttribute('contenteditable', 'false');
	container.textContent = '지도 로딩…';

	let instance: GeoMapInstance | null = null;
	void mountGeoMap(container, range.coords)
		.then((inst) => {
			instance = inst;
			if (!container.isConnected) inst.destroy();
		})
		.catch(() => {
			container.textContent = '지도 로딩 실패';
		});

	// Prevent PM selection on tap inside the map (would steal focus and pop
	// the mobile keyboard).
	container.addEventListener('mousedown', (e) => {
		e.stopPropagation();
	});

	// Best-effort cleanup if the element is detached (DecorationSet rebuild).
	queueMicrotask(() => {
		const parent = container.parentNode;
		if (!parent) return;
		const obs = new MutationObserver(() => {
			if (!container.isConnected) {
				instance?.destroy();
				obs.disconnect();
			}
		});
		obs.observe(parent, { childList: true });
	});

	return container;
}

export type AtomicKey = 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight';

export function handleGeoAtomicKey(
	state: EditorState,
	ranges: GeoUrlRange[],
	key: AtomicKey
): Transaction | null {
	const { selection } = state;
	if (!selection.empty) return null;
	const pos = selection.from;

	switch (key) {
		case 'Backspace': {
			const r = ranges.find((r) => r.to === pos);
			if (!r) return null;
			return state.tr.delete(r.from, r.to);
		}
		case 'Delete': {
			const r = ranges.find((r) => r.from === pos);
			if (!r) return null;
			return state.tr.delete(r.from, r.to);
		}
		case 'ArrowLeft': {
			const r = ranges.find((r) => r.to === pos);
			if (!r) return null;
			return state.tr.setSelection(TextSelection.create(state.doc, r.from));
		}
		case 'ArrowRight': {
			const r = ranges.find((r) => r.from === pos);
			if (!r) return null;
			return state.tr.setSelection(TextSelection.create(state.doc, r.to));
		}
	}
}

function keyFromEvent(e: KeyboardEvent): AtomicKey | null {
	if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
	if (e.key === 'Backspace' || e.key === 'Delete') return e.key;
	if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return e.key;
	return null;
}

export function createGeoMapPlugin(): Plugin<PluginState> {
	return new Plugin<PluginState>({
		key: geoMapPluginKey,
		state: {
			init: (_, s) => buildState(s.doc),
			apply(tr, old) {
				if (!tr.docChanged) return old;
				return buildState(tr.doc);
			}
		},
		props: {
			decorations(state) {
				return geoMapPluginKey.getState(state)?.decorations;
			},
			handleKeyDown(view, event) {
				const k = keyFromEvent(event);
				if (!k) return false;
				const st = geoMapPluginKey.getState(view.state);
				if (!st || st.ranges.length === 0) return false;
				const tr = handleGeoAtomicKey(view.state, st.ranges, k);
				if (!tr) return false;
				view.dispatch(tr);
				return true;
			}
		}
	});
}
