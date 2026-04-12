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

	// Top-level serialization keeps a single openMarks stack across paragraph
	// boundaries so that a mark spanning multiple paragraphs emits as one
	// continuous tag over the '\n' separator — e.g. <bold>a\nb</bold>, not
	// <bold>a</bold>\n<bold>b</bold>. This matches Tomboy desktop's output
	// where the text buffer applies a tag over a contiguous range that may
	// include '\n' characters.
	//
	// Important: we must only keep marks open across a '\n' when the *next*
	// rendered text node actually shares that outer→inner mark prefix.
	// Otherwise the '\n' separator leaks *inside* the mark — e.g. an empty
	// paragraph between a linked paragraph and an unlinked one would produce
	// `<link:internal>text\n\n</link:internal>next`, changing the semantics
	// on round-trip. We look ahead before each separator and close any marks
	// the next text node doesn't share.
	let result = '';
	let openMarks: JSONContent[] = [];

	function closeAll() {
		for (let i = openMarks.length - 1; i >= 0; i--) {
			result += markToTags(openMarks[i])[1];
		}
		openMarks = [];
	}

	function closeUnmatched(nextMarks: JSONContent[] | undefined) {
		const outerToInner = [...(nextMarks ?? [])].reverse();
		let common = 0;
		while (
			common < openMarks.length &&
			common < outerToInner.length &&
			marksEqual(openMarks[common], outerToInner[common])
		) {
			common++;
		}
		for (let i = openMarks.length - 1; i >= common; i--) {
			result += markToTags(openMarks[i])[1];
		}
		openMarks = openMarks.slice(0, common);
	}

	/** Find the first text-node inline in blocks[startIdx..]. */
	function nextTextNodeMarks(
		blocks: JSONContent[],
		startIdx: number
	): JSONContent[] | undefined {
		for (let i = startIdx; i < blocks.length; i++) {
			const b = blocks[i];
			if (b.type === 'paragraph' || b.type === 'heading') {
				for (const inline of b.content ?? []) {
					if (inline.type === 'text') return inline.marks ?? [];
					if (inline.type === 'hardBreak') return [];
				}
				// Empty paragraph — keep scanning subsequent blocks.
				continue;
			}
			// A list (or any non-inline block) forces a close; no marks to share.
			return [];
		}
		// No more text in the doc — close everything.
		return [];
	}

	function writeTextNode(node: JSONContent) {
		const outerToInner = [...(node.marks ?? [])].reverse();
		let common = 0;
		while (
			common < openMarks.length &&
			common < outerToInner.length &&
			marksEqual(openMarks[common], outerToInner[common])
		) {
			common++;
		}
		for (let i = openMarks.length - 1; i >= common; i--) {
			result += markToTags(openMarks[i])[1];
		}
		for (let i = common; i < outerToInner.length; i++) {
			result += markToTags(outerToInner[i])[0];
		}
		openMarks = outerToInner;
		result += escapeXmlContent(node.text ?? '');
	}

	// ProseMirror often places an auto-inserted empty paragraph after a list
	// so the cursor can live past the list's end. Tomboy desktop's XML never
	// emits that phantom paragraph, so we drop it here to keep round-trips
	// stable. (A user-authored empty paragraph elsewhere — e.g. blank line
	// between two text paragraphs — is NOT affected.)
	let nodes = doc.content;
	if (nodes.length >= 2) {
		const last = nodes[nodes.length - 1];
		const secondLast = nodes[nodes.length - 2];
		const isEmptyPara =
			last.type === 'paragraph' && (!last.content || last.content.length === 0);
		if (isEmptyPara && secondLast.type === 'bulletList') {
			nodes = nodes.slice(0, -1);
		}
	}

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];

		if (node.type === 'bulletList') {
			closeAll();
			result += serializeBulletList(node);
		} else if (node.type === 'paragraph' || node.type === 'heading') {
			for (const inline of node.content ?? []) {
				if (inline.type === 'text') {
					writeTextNode(inline);
				} else if (inline.type === 'hardBreak') {
					closeAll();
					result += '\n';
				}
			}
		}

		if (i < nodes.length - 1) {
			// Marks cannot continue across a list boundary — close them.
			if (node.type === 'bulletList' || nodes[i + 1].type === 'bulletList') {
				closeAll();
			} else {
				// Close marks that the next text node doesn't share, so the '\n'
				// separator ends up *outside* the mark tags.
				closeUnmatched(nextTextNodeMarks(nodes, i + 1));
			}
			result += '\n';
		}
	}

	closeAll();
	return `<note-content version="0.1">${result}</note-content>`;
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

	// True when the previous child was a block-level element (e.g. <list>).
	// The *next* '\n' we see belongs to that block as its separator, not as
	// a paragraph boundary — consume it without emitting a phantom empty para.
	let absorbNextNewline = false;

	// True when the last text node ended with '\n'. If we reach end-of-container
	// with no further inline content, that trailing newline opens an empty
	// paragraph (what Tomboy desktop sees as "cursor on a new empty line").
	let lastTextEndedWithNewline = false;

	// Push currentInline as a paragraph — empty paragraph if no inline content.
	function pushParagraph() {
		if (currentInline.length > 0) {
			blocks.push({ type: 'paragraph', content: currentInline });
			currentInline = [];
		} else {
			blocks.push({ type: 'paragraph' });
		}
	}

	// Flush any pending inline as a paragraph, but don't emit an empty one.
	// Used before block elements and at end of container.
	function flushPendingInline() {
		if (currentInline.length > 0) {
			blocks.push({ type: 'paragraph', content: currentInline });
			currentInline = [];
		}
	}

	// Append inline nodes (text with optional marks). If any text contains '\n'
	// — which Tomboy desktop produces for a mark that spans multiple lines,
	// e.g. <bold>a\nb</bold> — split into paragraph boundaries while re-applying
	// the same marks to each piece. This keeps ProseMirror text nodes free of
	// embedded newlines (invalid in its schema) and splits the logical mark
	// range into per-line marked text runs.
	function appendInlineNodes(nodes: JSONContent[]) {
		for (const n of nodes) {
			if (n.type === 'text' && typeof n.text === 'string') {
				if (n.text.length === 0) continue;
				if (n.text.includes('\n')) {
					const parts = n.text.split('\n');
					for (let j = 0; j < parts.length; j++) {
						if (j > 0) {
							if (absorbNextNewline) absorbNextNewline = false;
							else pushParagraph();
						}
						if (parts[j].length > 0) {
							const piece: JSONContent = { type: 'text', text: parts[j] };
							if (n.marks) piece.marks = n.marks;
							currentInline.push(piece);
							absorbNextNewline = false;
						}
					}
					lastTextEndedWithNewline = n.text.endsWith('\n');
				} else {
					currentInline.push(n);
					absorbNextNewline = false;
					lastTextEndedWithNewline = false;
				}
			} else {
				currentInline.push(n);
				absorbNextNewline = false;
				lastTextEndedWithNewline = false;
			}
		}
	}

	for (let i = 0; i < container.childNodes.length; i++) {
		const child = container.childNodes[i];

		if (child.nodeType === Node.TEXT_NODE) {
			const text = child.textContent ?? '';
			appendInlineNodes([{ type: 'text', text }]);
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			const tagName = el.tagName;

			if (tagName === 'list') {
				flushPendingInline();
				blocks.push(parseList(el));
				absorbNextNewline = true;
				lastTextEndedWithNewline = false;
			} else {
				// Inline formatting element — collect inline content with marks
				appendInlineNodes(parseInlineElement(el));
			}
		}
	}

	if (currentInline.length > 0) {
		flushPendingInline();
	} else if (lastTextEndedWithNewline) {
		// Trailing '\n' with no content after it → one extra empty paragraph.
		blocks.push({ type: 'paragraph' });
	}

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
 * Serialize inline content (text nodes with marks) to Tomboy XML, keeping
 * adjacent runs that share a mark inside a single open tag — matching the
 * Tomboy desktop serializer's tag_stack behavior
 * (ref/Tomboy/NoteBuffer.cs Serialize).
 *
 * ProseMirror stores marks per text node innermost-first. We reverse to get
 * outer→inner order for stable nesting, then open/close incrementally as
 * adjacent text nodes gain or drop marks.
 */
function serializeInlineContent(content: JSONContent[]): string {
	let result = '';
	let openMarks: JSONContent[] = []; // outer → inner

	function closeAll() {
		for (let i = openMarks.length - 1; i >= 0; i--) {
			result += markToTags(openMarks[i])[1];
		}
		openMarks = [];
	}

	for (const node of content) {
		if (node.type === 'text') {
			const outerToInner = [...(node.marks ?? [])].reverse();
			// Longest common prefix with currently open marks (outer→inner).
			let common = 0;
			while (
				common < openMarks.length &&
				common < outerToInner.length &&
				marksEqual(openMarks[common], outerToInner[common])
			) {
				common++;
			}
			// Close marks beyond the common prefix (innermost first).
			for (let i = openMarks.length - 1; i >= common; i--) {
				result += markToTags(openMarks[i])[1];
			}
			// Open the remaining new marks.
			for (let i = common; i < outerToInner.length; i++) {
				result += markToTags(outerToInner[i])[0];
			}
			openMarks = outerToInner;
			result += escapeXmlContent(node.text ?? '');
		} else if (node.type === 'hardBreak') {
			closeAll();
			result += '\n';
		}
	}

	closeAll();
	return result;
}

function marksEqual(a: JSONContent, b: JSONContent): boolean {
	if (a.type !== b.type) return false;
	const aAttrs = a.attrs ?? {};
	const bAttrs = b.attrs ?? {};
	const aKeys = Object.keys(aAttrs);
	const bKeys = Object.keys(bAttrs);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (aAttrs[k] !== bAttrs[k]) return false;
	}
	return true;
}

/**
 * Serialize a bulletList node to Tomboy XML.
 */
function serializeBulletList(node: JSONContent): string {
	let result = '<list>';

	const items = node.content ?? [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.type === 'listItem') {
			result += serializeListItem(item, i === items.length - 1);
		}
	}

	result += '</list>';
	return result;
}

/**
 * Serialize a listItem node to Tomboy XML.
 *
 * Tomboy desktop's output pattern (observed from real .note files):
 *   <list-item>text\n</list-item>            — non-last item, text only
 *   <list-item>text</list-item>              — last item of a list
 *   <list-item>text\n<list>…</list></list-item> — item with a nested list
 * The parser strips these structural '\n' characters, so we re-emit them here
 * to preserve byte-for-byte round-trip with the desktop format.
 */
function serializeListItem(item: JSONContent, isLast: boolean): string {
	let result = '<list-item dir="ltr">';

	const children = item.content ?? [];
	let hasNestedList = false;

	// Emit paragraph content first.
	for (const child of children) {
		if (child.type === 'paragraph') {
			result += serializeInlineContent(child.content ?? []);
		} else if (child.type === 'bulletList') {
			hasNestedList = true;
		}
	}

	if (hasNestedList) {
		// Tomboy inserts '\n' between the item's text and its nested list,
		// and no extra '\n' before </list-item>.
		result += '\n';
		for (const child of children) {
			if (child.type === 'bulletList') {
				result += serializeBulletList(child);
			}
		}
	} else if (!isLast) {
		// Non-last item without a nested list: trailing '\n' before </list-item>.
		result += '\n';
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
