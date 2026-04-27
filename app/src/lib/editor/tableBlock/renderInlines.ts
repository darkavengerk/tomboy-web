/**
 * Render an array of TipTap inline nodes (text + marks) into a
 * `DocumentFragment` for use inside table-cell DOM. Mark→tag mapping
 * mirrors the editor's own conventions so cells can carry bold, italic,
 * internal links (`data-link-target`), URL links, monospace, sizes, etc.
 *
 * Internal-link clicks are NOT bound here — links carry the
 * `data-link-target` attribute and rely on the editor's existing
 * `editorProps.handleClick` to fire `oninternallink`. (See
 * `TomboyEditor.svelte`.) URL links open in a new tab.
 */

import type { JSONContent } from '@tiptap/core';

export function renderInlinesToDom(inlines: JSONContent[]): DocumentFragment {
	const frag = document.createDocumentFragment();
	for (const node of inlines) {
		if (node.type === 'hardBreak') {
			frag.appendChild(document.createElement('br'));
			continue;
		}
		if (node.type !== 'text' || typeof node.text !== 'string') continue;
		if (node.text.length === 0) continue;

		// Marks are stored outer→inner. Build innermost-first so the
		// outermost wrapper ends up around the whole chain — i.e. the
		// `[bold, italic]` mark order yields `<strong><em>x</em></strong>`.
		let el: Node = document.createTextNode(node.text);
		const marks = (node.marks ?? []) as JSONContent[];
		for (let i = marks.length - 1; i >= 0; i--) {
			const wrapper = createMarkElement(marks[i]);
			if (!wrapper) continue;
			wrapper.appendChild(el);
			el = wrapper;
		}
		frag.appendChild(el);
	}
	return frag;
}

function createMarkElement(mark: JSONContent): HTMLElement | null {
	switch (mark.type) {
		case 'bold':
			return document.createElement('strong');
		case 'italic':
			return document.createElement('em');
		case 'strike':
			return document.createElement('s');
		case 'underline':
			return document.createElement('u');
		case 'highlight':
			return document.createElement('mark');
		case 'tomboyMonospace': {
			const el = document.createElement('span');
			el.className = 'tomboy-monospace';
			return el;
		}
		case 'tomboySize': {
			const level = mark.attrs?.level ?? 'normal';
			const el = document.createElement('span');
			el.className = `tomboy-size-${level}`;
			return el;
		}
		case 'tomboyInternalLink': {
			const a = document.createElement('a');
			const target = mark.attrs?.target ?? '';
			a.setAttribute('data-link-target', target);
			a.className = mark.attrs?.broken
				? 'tomboy-link-broken'
				: 'tomboy-link-internal';
			a.href = '#';
			return a;
		}
		case 'tomboyUrlLink': {
			const a = document.createElement('a');
			const href = mark.attrs?.href ?? '';
			a.setAttribute('href', href);
			a.className = 'tomboy-link-url';
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			return a;
		}
		case 'tomboyDatetime': {
			const el = document.createElement('span');
			el.className = 'tomboy-datetime';
			return el;
		}
		default:
			return null;
	}
}
