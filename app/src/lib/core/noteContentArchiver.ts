/**
 * Bidirectional converter between Tomboy note-content XML and TipTap/ProseMirror JSON.
 *
 * Tomboy XML tags → ProseMirror marks/nodes:
 *   <bold>         → mark: bold
 *   <italic>       → mark: italic
 *   <strikethrough>→ mark: strike
 *   <underline>    → mark: underline
 *   <highlight>    → mark: highlight
 *   <monospace>    → mark: tomboyMonospace
 *   <size:huge>    → mark: tomboySize { level: 'huge' }
 *   <size:large>   → mark: tomboySize { level: 'large' }
 *   <size:small>   → mark: tomboySize { level: 'small' }
 *   <link:internal>→ mark: tomboyInternalLink { target: text }
 *   <link:url>     → mark: tomboyUrlLink { href: text }
 *   <list>/<list-item> → node: bulletList / listItem
 *   \n             → node: paragraph boundary or hardBreak
 *
 * The first line of note-content is the title.
 */

import type { JSONContent } from '@tiptap/core';

// --- XML → ProseMirror JSON ---

/**
 * Parse a Tomboy note-content XML string into a TipTap-compatible JSON document.
 */
export function deserializeContent(xmlContent: string): JSONContent {
	const inner = extractInnerContent(xmlContent);
	if (!inner) {
		return { type: 'doc', content: [{ type: 'paragraph' }] };
	}

	const wrapper = `<root xmlns:link="http://beatniksoftware.com/tomboy/link" xmlns:size="http://beatniksoftware.com/tomboy/size">${inner}</root>`;
	const parser = new DOMParser();
	const doc = parser.parseFromString(wrapper, 'text/xml');
	const root = doc.documentElement;

	const blocks = parseBlocks(root);

	if (blocks.length === 0) {
		return { type: 'doc', content: [{ type: 'paragraph' }] };
	}

	return { type: 'doc', content: blocks };
}

/**
 * Serialize a TipTap JSON document back to Tomboy note-content XML string.
 */
export function serializeContent(doc: JSONContent): string {
	if (!doc.content || doc.content.length === 0) {
		return `<note-content version="0.1">\n</note-content>`;
	}

	const parts: string[] = [];

	for (let i = 0; i < doc.content.length; i++) {
		const node = doc.content[i];

		if (node.type === 'bulletList') {
			parts.push(serializeBulletList(node));
		} else if (node.type === 'paragraph' || node.type === 'heading') {
			const inline = serializeInlineContent(node.content ?? []);
			parts.push(inline);
			// Add newline between blocks, except after the last one
			if (i < doc.content.length - 1) {
				parts.push('\n');
			}
		}
	}

	return `<note-content version="0.1">${parts.join('')}</note-content>`;
}

/**
 * Extract the title (first line) from a TipTap JSON document.
 */
export function extractTitleFromDoc(doc: JSONContent): string {
	if (!doc.content || doc.content.length === 0) return '';
	const firstBlock = doc.content[0];
	return getPlainText(firstBlock);
}

// --- Internal: XML → PM JSON ---

/**
 * Extract the text inside <note-content>...</note-content>.
 */
function extractInnerContent(xmlContent: string): string | null {
	const startMatch = xmlContent.match(/<note-content[^>]*>/);
	const endTag = '</note-content>';
	if (!startMatch) return null;

	const startIdx = xmlContent.indexOf(startMatch[0]) + startMatch[0].length;
	const endIdx = xmlContent.indexOf(endTag);
	if (endIdx === -1) return null;

	return xmlContent.substring(startIdx, endIdx);
}

/**
 * Parse XML child nodes into an array of ProseMirror block nodes.
 * Text is split by newlines into paragraphs.
 * <list> elements become bulletList nodes.
 */
function parseBlocks(container: Element): JSONContent[] {
	const blocks: JSONContent[] = [];
	let currentInline: JSONContent[] = [];

	function flushParagraph() {
		if (currentInline.length > 0) {
			blocks.push({ type: 'paragraph', content: currentInline });
			currentInline = [];
		} else if (blocks.length > 0 || container.childNodes.length > 0) {
			// Empty paragraph for blank lines — but only push if we've already started content
		}
	}

	for (let i = 0; i < container.childNodes.length; i++) {
		const child = container.childNodes[i];

		if (child.nodeType === Node.TEXT_NODE) {
			const text = child.textContent ?? '';
			const lines = text.split('\n');
			for (let j = 0; j < lines.length; j++) {
				if (j > 0) {
					flushParagraph();
				}
				if (lines[j].length > 0) {
					currentInline.push({ type: 'text', text: lines[j] });
				}
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			const tagName = el.tagName;

			if (tagName === 'list') {
				flushParagraph();
				blocks.push(parseList(el));
			} else {
				// Inline formatting element — collect inline content with marks
				const inlineNodes = parseInlineElement(el);
				currentInline.push(...inlineNodes);
			}
		}
	}

	flushParagraph();

	// Ensure at least one block
	if (blocks.length === 0) {
		blocks.push({ type: 'paragraph' });
	}

	return blocks;
}

/**
 * Parse an inline element (<bold>, <italic>, etc.) into text nodes with marks.
 */
function parseInlineElement(el: Element): JSONContent[] {
	const mark = elementToMark(el);
	const result: JSONContent[] = [];

	for (let i = 0; i < el.childNodes.length; i++) {
		const child = el.childNodes[i];

		if (child.nodeType === Node.TEXT_NODE) {
			const text = child.textContent ?? '';
			if (text.length > 0) {
				const node: JSONContent = { type: 'text', text };
				if (mark) {
					node.marks = [mark];
				}
				result.push(node);
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			// Nested formatting: e.g. <bold><italic>text</italic></bold>
			const nested = parseInlineElement(child as Element);
			if (mark) {
				for (const n of nested) {
					n.marks = [...(n.marks ?? []), mark];
				}
			}
			result.push(...nested);
		}
	}

	return result;
}

/**
 * Map a Tomboy XML element to a ProseMirror mark.
 */
function elementToMark(el: Element): JSONContent | null {
	const tag = el.tagName;

	switch (tag) {
		case 'bold':
			return { type: 'bold' };
		case 'italic':
			return { type: 'italic' };
		case 'strikethrough':
			return { type: 'strike' };
		case 'underline':
			return { type: 'underline' };
		case 'highlight':
			return { type: 'highlight' };
		case 'monospace':
			return { type: 'tomboyMonospace' };
		case 'size:huge':
			return { type: 'tomboySize', attrs: { level: 'huge' } };
		case 'size:large':
			return { type: 'tomboySize', attrs: { level: 'large' } };
		case 'size:small':
			return { type: 'tomboySize', attrs: { level: 'small' } };
		case 'link:internal':
			return { type: 'tomboyInternalLink', attrs: { target: el.textContent ?? '' } };
		case 'link:url':
			return { type: 'tomboyUrlLink', attrs: { href: el.textContent ?? '' } };
		case 'link:broken':
			return { type: 'tomboyInternalLink', attrs: { target: el.textContent ?? '', broken: true } };
		default:
			return null;
	}
}

/**
 * Parse a <list> element into a bulletList node.
 */
function parseList(listEl: Element): JSONContent {
	const items: JSONContent[] = [];

	for (let i = 0; i < listEl.childNodes.length; i++) {
		const child = listEl.childNodes[i];
		if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'list-item') {
			items.push(parseListItem(child as Element));
		}
	}

	return { type: 'bulletList', content: items };
}

/**
 * Parse a <list-item> element into a listItem node.
 * A list-item can contain inline text and nested <list> elements.
 */
function parseListItem(itemEl: Element): JSONContent {
	const content: JSONContent[] = [];
	let inlineContent: JSONContent[] = [];

	function flushInline() {
		if (inlineContent.length > 0) {
			content.push({ type: 'paragraph', content: inlineContent });
			inlineContent = [];
		}
	}

	for (let i = 0; i < itemEl.childNodes.length; i++) {
		const child = itemEl.childNodes[i];

		if (child.nodeType === Node.TEXT_NODE) {
			const text = (child.textContent ?? '').replace(/\n/g, '');
			if (text.length > 0) {
				inlineContent.push({ type: 'text', text });
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			if (el.tagName === 'list') {
				flushInline();
				content.push(parseList(el));
			} else {
				const nodes = parseInlineElement(el);
				inlineContent.push(...nodes);
			}
		}
	}

	flushInline();

	if (content.length === 0) {
		content.push({ type: 'paragraph' });
	}

	return { type: 'listItem', content };
}

// --- Internal: PM JSON → XML ---

/**
 * Serialize inline content (text nodes with marks) to Tomboy XML.
 */
function serializeInlineContent(content: JSONContent[]): string {
	let result = '';

	for (const node of content) {
		if (node.type === 'text') {
			let text = escapeXmlContent(node.text ?? '');
			const marks = node.marks ?? [];
			// Wrap text in mark tags (innermost first)
			for (const mark of marks) {
				const [open, close] = markToTags(mark);
				text = `${open}${text}${close}`;
			}
			result += text;
		} else if (node.type === 'hardBreak') {
			result += '\n';
		}
	}

	return result;
}

/**
 * Serialize a bulletList node to Tomboy XML.
 */
function serializeBulletList(node: JSONContent): string {
	let result = '<list>';

	for (const item of node.content ?? []) {
		if (item.type === 'listItem') {
			result += serializeListItem(item);
		}
	}

	result += '</list>';
	return result;
}

/**
 * Serialize a listItem node to Tomboy XML.
 */
function serializeListItem(item: JSONContent): string {
	let result = '<list-item dir="ltr">';

	for (const child of item.content ?? []) {
		if (child.type === 'paragraph') {
			result += serializeInlineContent(child.content ?? []);
		} else if (child.type === 'bulletList') {
			result += '\n' + serializeBulletList(child);
		}
	}

	result += '</list-item>';
	return result;
}

/**
 * Map a ProseMirror mark to Tomboy XML open/close tags.
 */
function markToTags(mark: JSONContent): [string, string] {
	switch (mark.type) {
		case 'bold':
			return ['<bold>', '</bold>'];
		case 'italic':
			return ['<italic>', '</italic>'];
		case 'strike':
			return ['<strikethrough>', '</strikethrough>'];
		case 'underline':
			return ['<underline>', '</underline>'];
		case 'highlight':
			return ['<highlight>', '</highlight>'];
		case 'tomboyMonospace':
			return ['<monospace>', '</monospace>'];
		case 'tomboySize': {
			const level = mark.attrs?.level ?? 'normal';
			return [`<size:${level}>`, `</size:${level}>`];
		}
		case 'tomboyInternalLink': {
			if (mark.attrs?.broken) {
				return ['<link:broken>', '</link:broken>'];
			}
			return ['<link:internal>', '</link:internal>'];
		}
		case 'tomboyUrlLink':
			return ['<link:url>', '</link:url>'];
		default:
			return ['', ''];
	}
}

/**
 * Escape XML special characters in text content.
 */
function escapeXmlContent(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Get plain text from a block node (strips marks).
 */
function getPlainText(node: JSONContent): string {
	if (node.text) return node.text;
	if (!node.content) return '';
	return node.content.map(getPlainText).join('');
}
