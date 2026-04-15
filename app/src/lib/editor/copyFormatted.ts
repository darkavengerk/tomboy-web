import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Markdown special chars that must be escaped in plain text runs.
const MD_ESCAPE_RE = /([*_\[\]`\\])/g;
function escapeMd(s: string): string {
	return s.replace(MD_ESCAPE_RE, '\\$1');
}

function getTextNodes(node: JSONContent): string {
	if (node.type === 'text') return node.text ?? '';
	return (node.content ?? []).map(getTextNodes).join('');
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function plainNode(node: JSONContent, indent: number): string {
	switch (node.type) {
		case 'doc':
			return plainChildren(node.content ?? [], indent);
		case 'paragraph': {
			const parts: string[] = [];
			for (const child of node.content ?? []) {
				if (child.type === 'hardBreak') parts.push('\n');
				else parts.push(getTextNodes(child));
			}
			return parts.join('');
		}
		case 'bulletList':
		case 'orderedList':
			return (node.content ?? []).map((li) => plainListItem(li, indent)).join('\n');
		case 'listItem': {
			// listItem can contain paragraphs + nested lists; handled by plainListItem
			return plainListItem(node, indent);
		}
		case 'hardBreak':
			return '\n';
		default:
			return plainChildren(node.content ?? [], indent);
	}
}

function plainListItem(li: JSONContent, indent: number): string {
	const prefix = ' '.repeat(indent * 2) + '- ';
	const lines: string[] = [];
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph') {
			lines.push(prefix + getTextNodes(child));
		} else if (child.type === 'bulletList' || child.type === 'orderedList') {
			const nested = (child.content ?? [])
				.map((nestedLi) => plainListItem(nestedLi, indent + 1))
				.join('\n');
			lines.push(nested);
		}
	}
	return lines.join('\n');
}

function plainChildren(children: JSONContent[], indent: number): string {
	const parts: string[] = [];
	for (const child of children) {
		if (child.type === 'bulletList' || child.type === 'orderedList') {
			parts.push(plainNode(child, indent));
		} else if (child.type === 'paragraph') {
			parts.push(plainNode(child, indent));
		} else {
			parts.push(plainNode(child, indent));
		}
	}
	return parts.join('\n');
}

export function tiptapToPlainText(json: JSONContent): string {
	if (json.type !== 'doc') {
		// Fragment: treat as a single node
		return plainNode(json, 0);
	}
	const children = json.content ?? [];
	if (children.length === 0) return '';
	const parts: string[] = [];
	for (const child of children) {
		parts.push(plainNode(child, 0));
	}
	// Filter out the trailing empty string from trailing newlines inside lists
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function htmlMark(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
	let s = text;
	// Apply marks inside-out (last mark is outermost)
	for (const mark of [...marks].reverse()) {
		switch (mark.type) {
			case 'bold': s = `<strong>${s}</strong>`; break;
			case 'italic': s = `<em>${s}</em>`; break;
			case 'strike': s = `<s>${s}</s>`; break;
			case 'tomboyMonospace': s = `<code>${s}</code>`; break;
			case 'tomboyUrlLink': {
				const href = escapeHtml(String(mark.attrs?.href ?? ''));
				s = `<a href="${href}">${s}</a>`;
				break;
			}
			case 'tomboyInternalLink': s = `<a data-link-target="${escapeHtml(String(mark.attrs?.target ?? ''))}">${s}</a>`; break;
			case 'highlight': s = `<mark>${s}</mark>`; break;
			case 'underline': s = `<u>${s}</u>`; break;
		}
	}
	return s;
}

function htmlNode(node: JSONContent): string {
	switch (node.type) {
		case 'doc':
			return (node.content ?? []).map(htmlNode).join('');
		case 'text': {
			const safe = escapeHtml(node.text ?? '');
			const marks = node.marks ?? [];
			return marks.length ? htmlMark(safe, marks) : safe;
		}
		case 'paragraph':
			return `<p>${(node.content ?? []).map(htmlNode).join('')}</p>`;
		case 'hardBreak':
			return '<br>';
		case 'bulletList':
			return `<ul>${(node.content ?? []).map(htmlNode).join('')}</ul>`;
		case 'orderedList':
			return `<ol>${(node.content ?? []).map(htmlNode).join('')}</ol>`;
		case 'listItem':
			return `<li>${(node.content ?? []).map(htmlNode).join('')}</li>`;
		default:
			return (node.content ?? []).map(htmlNode).join('');
	}
}

export function tiptapToHtml(json: JSONContent): string {
	return htmlNode(json);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function mdMarks(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): string {
	if (!marks.length) return text;
	let s = text;
	const hasBold = marks.some((m) => m.type === 'bold');
	const hasItalic = marks.some((m) => m.type === 'italic');
	const hasStrike = marks.some((m) => m.type === 'strike');
	const hasCode = marks.some((m) => m.type === 'tomboyMonospace');
	const urlMark = marks.find((m) => m.type === 'tomboyUrlLink');
	const internalMark = marks.find((m) => m.type === 'tomboyInternalLink');

	// Code overrides other formatting (backtick doesn't nest).
	if (hasCode) return `\`${s}\``;
	if (urlMark) return `[${s}](${urlMark.attrs?.href ?? ''})`;
	if (internalMark) return `[[${s}]]`;

	if (hasBold && hasItalic) return `***${s}***`;
	if (hasBold) return `**${s}**`;
	if (hasItalic) return `*${s}*`;
	if (hasStrike) return `~~${s}~~`;
	return s;
}

function mdNode(node: JSONContent, indent: number, insideList: boolean): string {
	switch (node.type) {
		case 'doc': {
			const parts: string[] = [];
			for (const child of node.content ?? []) {
				parts.push(mdNode(child, 0, false));
			}
			// Paragraphs separated by blank line; lists are self-contained.
			return parts.join('\n\n');
		}
		case 'text': {
			const raw = node.text ?? '';
			const marks = node.marks ?? [];
			// Escape plain text only if no special marks that produce wrappers.
			const hasWrapper = marks.some((m) =>
				['bold', 'italic', 'strike', 'tomboyMonospace', 'tomboyUrlLink', 'tomboyInternalLink'].includes(m.type)
			);
			const text = hasWrapper ? raw : escapeMd(raw);
			return mdMarks(text, marks);
		}
		case 'paragraph': {
			return (node.content ?? []).map((c) => mdNode(c, indent, insideList)).join('');
		}
		case 'hardBreak':
			return '\n';
		case 'bulletList':
		case 'orderedList': {
			return (node.content ?? []).map((li) => mdListItem(li, indent)).join('\n');
		}
		default:
			return (node.content ?? []).map((c) => mdNode(c, indent, insideList)).join('');
	}
}

function mdListItem(li: JSONContent, indent: number): string {
	const prefix = ' '.repeat(indent * 2) + '- ';
	const lines: string[] = [];
	for (const child of li.content ?? []) {
		if (child.type === 'paragraph') {
			lines.push(prefix + mdNode(child, indent, true));
		} else if (child.type === 'bulletList' || child.type === 'orderedList') {
			const nested = (child.content ?? [])
				.map((nestedLi) => mdListItem(nestedLi, indent + 1))
				.join('\n');
			lines.push(nested);
		}
	}
	return lines.join('\n');
}

export function tiptapToMarkdown(json: JSONContent): string {
	if (json.type !== 'doc') {
		// Fragment: single node
		if (json.type === 'bulletList' || json.type === 'orderedList') {
			return (json.content ?? []).map((li) => mdListItem(li, 0)).join('\n');
		}
		return mdNode(json, 0, false);
	}
	const children = json.content ?? [];
	if (children.length === 0) return '';

	// Separate top-level nodes: lists are joined with \n, paragraphs with \n\n.
	const parts: string[] = [];
	for (const child of children) {
		if (child.type === 'bulletList' || child.type === 'orderedList') {
			parts.push((child.content ?? []).map((li) => mdListItem(li, 0)).join('\n'));
		} else {
			parts.push(mdNode(child, 0, false));
		}
	}
	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Selection helper (used by context menu)
// ---------------------------------------------------------------------------

export function copySelectionAsJson(editor: Editor): JSONContent {
	const sel = editor.state.selection;
	if (sel.empty) return editor.getJSON();
	const slice = sel.content();
	return { type: 'doc', content: slice.content.toJSON() as JSONContent[] };
}
