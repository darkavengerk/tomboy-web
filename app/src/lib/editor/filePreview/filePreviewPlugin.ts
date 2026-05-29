/**
 * ProseMirror plugin that renders bridge file URLs as inline 📎-badge
 * widgets (clickable <a>). Scoped to URLs whose host matches the
 * configured bridge HTTP base and whose path matches `/files/<uuid>/<name>`.
 *
 * Unlike `imagePreviewPlugin`, this plugin does NOT implement atomic-character
 * key handling — file URLs use the standard cursor behavior. The URL is just
 * visually replaced with a clickable badge while remaining intact in the doc.
 *
 * Invariant: the document is never mutated by rendering — the URL stays
 * verbatim so Tomboy XML round-trip is stable.
 */

import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
	bridgeToHttpBase,
	getDefaultTerminalBridge
} from '$lib/editor/terminal/bridgeSettings.js';
import { createFileBadgeElement } from './fileBadge.js';

export const filePreviewPluginKey = new PluginKey<PluginState>('tomboyFilePreview');

export interface FileUrlRange {
	from: number;
	to: number;
	href: string;
}

interface PluginState {
	decorations: DecorationSet;
	ranges: FileUrlRange[];
	httpBase: string;
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]\}>]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function findFileUrlRanges(doc: PMNode, httpBase: string): FileUrlRange[] {
	const out: FileUrlRange[] = [];
	if (!httpBase) return out;
	const baseNormalized = httpBase.replace(/\/$/, '');
	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		const text = node.text;
		URL_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = URL_RE.exec(text)) !== null) {
			let url = m[0];
			while (true) {
				const trimmed = url.replace(TRAILING_PUNCT_RE, '');
				if (trimmed === url) break;
				url = trimmed;
			}
			if (!url.startsWith(baseNormalized + '/files/')) continue;
			const rest = url.slice((baseNormalized + '/files/').length);
			const slash = rest.indexOf('/');
			if (slash < 0) continue;
			const uuid = rest.slice(0, slash);
			if (!UUID_RE.test(uuid)) continue;
			const filename = rest.slice(slash + 1);
			if (!filename) continue;
			const start = m.index;
			out.push({
				from: pos + start,
				to: pos + start + url.length,
				href: url
			});
		}
	});
	return out;
}

function buildState(doc: PMNode, httpBase: string): PluginState {
	const ranges = findFileUrlRanges(doc, httpBase);
	if (ranges.length === 0) {
		return { decorations: DecorationSet.empty, ranges, httpBase };
	}
	const decos: Decoration[] = [];
	for (const r of ranges) {
		decos.push(
			Decoration.inline(
				r.from,
				r.to,
				{ class: 'tomboy-file-url-hidden' },
				{ inclusiveStart: false, inclusiveEnd: false }
			)
		);
		decos.push(
			Decoration.widget(r.to, () => createFileBadgeElement(r.href), {
				side: 1,
				key: `file:${r.from}:${r.to}:${r.href}`
			})
		);
	}
	return { decorations: DecorationSet.create(doc, decos), ranges, httpBase };
}

async function resolveHttpBase(): Promise<string> {
	const bridge = await getDefaultTerminalBridge();
	if (!bridge) return '';
	return bridgeToHttpBase(bridge).replace(/\/$/, '');
}

export function createFilePreviewPlugin(): Plugin<PluginState> {
	let cachedBase = '';
	return new Plugin<PluginState>({
		key: filePreviewPluginKey,
		state: {
			init: (_, s) => buildState(s.doc, cachedBase),
			apply(tr, old) {
				const m = tr.getMeta(filePreviewPluginKey);
				if (!tr.docChanged && old.httpBase === cachedBase && m !== 'rebuild')
					return old;
				return buildState(tr.doc, cachedBase);
			}
		},
		view(view) {
			void resolveHttpBase().then((b) => {
				if (b === cachedBase) return;
				cachedBase = b;
				try {
					view.dispatch(view.state.tr.setMeta(filePreviewPluginKey, 'rebuild'));
				} catch {
					// view may have been destroyed before resolve — ignore.
				}
			});
			return {};
		},
		props: {
			decorations(state: EditorState) {
				return filePreviewPluginKey.getState(state)?.decorations;
			}
		}
	});
}
