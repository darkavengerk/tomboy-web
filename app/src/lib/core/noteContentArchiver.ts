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

// Mark types that must NEVER span a paragraph boundary — a link or datetime
// reference is a self-contained anchor, so `<link:internal>A\nB</link:internal>`
// would incorrectly bundle two anchors into one. When such a mark legitimately
// applies to a separator '\n' (e.g. `<datetime>\n</datetime>` between blocks
// in the source), it is preserved via `attrs.tomboyTrailingMarks` on the
// outgoing paragraph and re-emitted around the separator on serialize.
const NON_SPANNING_MARK_TYPES = new Set([
	'tomboyInternalLink',
	'tomboyUrlLink',
	'tomboyDatetime'
]);

// Per-element counter used to mint unique `instanceId` attrs on NON_SPANNING
// anchor marks (datetime / link:internal / link:url). Two source elements
// therefore produce marks that compare unequal, which the serializer uses to
// emit them as separate XML elements instead of coalescing adjacent runs of
// the "same" mark. Reset at the start of every deserialize so IDs are
// deterministic per input and round-trip cleanly.
let instanceIdCounter = 0;
function mintInstanceId(): string {
	return `p${instanceIdCounter++}`;
}

// --- XML → ProseMirror JSON ---

/**
 * Parse a Tomboy note-content XML string into a TipTap-compatible JSON document.
 */
export function deserializeContent(xmlContent: string): JSONContent {
	instanceIdCounter = 0;
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
		// marks are stored outer→inner (TipTap convention); use them as-is.
		const outerToInner = node.marks ?? [];
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
			result += serializeBulletList(node, /*isTopLevel=*/ true);
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
			// TipTap extensions with `default: null` materialise the attr as
			// null (not undefined) on every node. Coerce to undefined so the
			// fallback path kicks in for editor-authored docs.
			const rawTrailing = node.attrs?.tomboyTrailingMarks;
			const attrTrailing =
				Array.isArray(rawTrailing) ? (rawTrailing as JSONContent[]) : undefined;
			// Explicit trailingMarks (from our parser) authoritatively describe
			// the marks applied to the '\n' char in the source. Without them
			// (editor-authored or hand-crafted docs), fall back to next text's
			// marks so spanning marks like <bold> keep continuity — but strip
			// NON_SPANNING types so `<link:internal>A</link:internal>` in two
			// paragraphs doesn't merge into one anchor on output.
			let separatorMarks: JSONContent[];
			if (attrTrailing !== undefined) {
				separatorMarks = attrTrailing;
			} else {
				// Common prefix (outer→inner) of currently-open marks and the
				// next text's marks — exactly the marks that span continuously
				// across the '\n'. Excludes NON_SPANNING anchor marks to avoid
				// merging two adjacent-paragraph anchors into one span.
				const nextMarks = nextTextNodeMarks(nodes, i + 1) ?? [];
				const shared: JSONContent[] = [];
				for (let k = 0; k < openMarks.length && k < nextMarks.length; k++) {
					if (!marksEqual(openMarks[k], nextMarks[k])) break;
					const m = openMarks[k];
					if (m.type && NON_SPANNING_MARK_TYPES.has(m.type)) break;
					shared.push(m);
				}
				separatorMarks = shared;
			}
			// Emit the separator '\n' as a phantom text node; writeTextNode's
			// close/open-with-common-prefix logic keeps marks continuous
			// across the '\n' when all three sides (before / the '\n' itself /
			// after) share them.
			writeTextNode({
				type: 'text',
				text: '\n',
				...(separatorMarks.length > 0 ? { marks: separatorMarks } : {})
			} as JSONContent);
			// A bulletList boundary can't carry open marks into its inner
			// serialization — close everything that's still open.
			if (node.type === 'bulletList' || nodes[i + 1].type === 'bulletList') {
				closeAll();
			}
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
	// `trailingMarks` captures marks that applied to the separator '\n' after
	// this paragraph in the source XML (e.g. `<datetime>\n</datetime>`). They
	// are re-emitted around the block separator on serialize so the round-trip
	// is byte-stable.
	function pushParagraph(trailingMarks?: JSONContent[]) {
		const p: JSONContent =
			currentInline.length > 0
				? { type: 'paragraph', content: currentInline }
				: { type: 'paragraph' };
		if (trailingMarks && trailingMarks.length > 0) {
			p.attrs = { ...(p.attrs ?? {}), tomboyTrailingMarks: trailingMarks };
		}
		blocks.push(p);
		currentInline = [];
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
							// A '\n' inside a marked text node carries those
							// marks in Tomboy's flat-buffer model. Capture
							// them on the outgoing paragraph as trailingMarks
							// so serialize's phantom-'\n' emission keeps the
							// mark continuous across the block boundary when
							// appropriate.
							else pushParagraph(n.marks);
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
			// We prepend the parent mark so marks arrays are stored
			// outermost-first — the same convention TipTap/PM returns from
			// `editor.getJSON()`. Previously we appended (innermost-first),
			// which meant editor-authored JSON flowed in with the opposite
			// ordering and the serializer flipped nesting (e.g. produced
			// `<link><strike>X</strike></link>` for a source that wrote
			// `<strike><link>X</link></strike>`).
			const nested = parseInlineElement(child as Element);
			if (mark) {
				for (const n of nested) {
					n.marks = [mark, ...(n.marks ?? [])];
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
type Mark = { type: string; attrs?: Record<string, any> };
function elementToMark(el: Element): Mark | null {
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
			return {
				type: 'tomboyInternalLink',
				attrs: { target: el.textContent ?? '', instanceId: mintInstanceId() }
			};
		case 'link:url':
			return {
				type: 'tomboyUrlLink',
				attrs: { href: el.textContent ?? '', instanceId: mintInstanceId() }
			};
		case 'link:broken':
			return {
				type: 'tomboyInternalLink',
				attrs: {
					target: el.textContent ?? '',
					broken: true,
					instanceId: mintInstanceId()
				}
			};
		case 'datetime':
			return { type: 'tomboyDatetime', attrs: { instanceId: mintInstanceId() } };
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
	// A `<mark>\n</mark>` sitting between the item's inline text and a nested
	// <list> is Tomboy's way of applying a tag to the separator newline. We
	// capture the mark here so the flushed paragraph carries it as
	// trailingMarks, and the serializer can re-wrap the separator on output.
	let pendingTrailingMarks: JSONContent[] | undefined;

	function flushInline() {
		if (inlineContent.length > 0) {
			const p: JSONContent = { type: 'paragraph', content: inlineContent };
			if (pendingTrailingMarks && pendingTrailingMarks.length > 0) {
				p.attrs = { tomboyTrailingMarks: pendingTrailingMarks };
			}
			content.push(p);
			inlineContent = [];
			pendingTrailingMarks = undefined;
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
				// A marked inline element containing only '\n' is a separator
				// marker; its marks belong on the pending paragraph, not as a
				// text node (PM schema disallows '\n' inside text nodes).
				const isPureNewline =
					nodes.length === 1 &&
					nodes[0].type === 'text' &&
					nodes[0].text === '\n';
				if (isPureNewline) {
					pendingTrailingMarks = nodes[0].marks;
				} else {
					inlineContent.push(...nodes);
				}
			}
		}
	}

	flushInline();

	if (content.length === 0) {
		content.push({ type: 'paragraph' });
	}

	// Remember whether the source XML had a '\n' immediately before
	// </list-item>. Tomboy's usual convention is "nested last item has \n,
	// top-level last item does not", but real files produced by other tools
	// or edge cases (a note that ends at the deepest list) can violate that.
	// Tracking it per item keeps round-trip byte-stable.
	let hasTrailingNewline = false;
	for (let k = itemEl.childNodes.length - 1; k >= 0; k--) {
		const c = itemEl.childNodes[k];
		if (c.nodeType === Node.TEXT_NODE) {
			const t = c.textContent ?? '';
			if (t.length === 0) continue;
			hasTrailingNewline = t.endsWith('\n');
			break;
		} else if (c.nodeType === Node.ELEMENT_NODE) {
			const tag = (c as Element).tagName;
			if (tag === 'list') {
				// A nested <list> is followed by `</list-item>` directly; no \n.
				hasTrailingNewline = false;
			} else {
				hasTrailingNewline = ((c as Element).textContent ?? '').endsWith('\n');
			}
			break;
		}
	}

	return {
		type: 'listItem',
		attrs: { tomboyTrailingNewline: hasTrailingNewline },
		content
	};
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
			const outerToInner = node.marks ?? [];
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
 *
 * `isTopLevel` indicates whether this list sits directly inside the
 * note-content body (true) or is nested inside a list-item (false). Tomboy's
 * pattern: the LAST list-item of a top-level list has no trailing '\n'
 * (the '\n' lives outside, as the block separator), whereas the last item of
 * a nested list DOES keep its trailing '\n' because it sits inside a
 * containing list-item.
 */
function serializeBulletList(node: JSONContent, isTopLevel: boolean): string {
	let result = '<list>';

	const items = node.content ?? [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.type === 'listItem') {
			const isLastTopLevel = isTopLevel && i === items.length - 1;
			result += serializeListItem(item, isLastTopLevel);
		}
	}

	result += '</list>';
	return result;
}

/**
 * Serialize a listItem node to Tomboy XML.
 *
 * Whether a '\n' appears immediately before `</list-item>` depends on the
 * source. The parser records this per item as `attrs.tomboyTrailingNewline`.
 * When the attr is missing (items authored inside the editor without going
 * through parse), fall back to Tomboy's positional convention:
 *   last item of a top-level list → no trailing '\n'
 *   any other item                 → trailing '\n'
 */
function serializeListItem(item: JSONContent, isLastTopLevel: boolean): string {
	let result = '<list-item dir="ltr">';

	const children = item.content ?? [];
	let hasNestedList = false;
	let trailingMarks: JSONContent[] | undefined;

	// Emit paragraph content first.
	for (const child of children) {
		if (child.type === 'paragraph') {
			result += serializeInlineContent(child.content ?? []);
			const t = child.attrs?.tomboyTrailingMarks;
			if (Array.isArray(t) && t.length > 0) trailingMarks = t as JSONContent[];
		} else if (child.type === 'bulletList') {
			hasNestedList = true;
		}
	}

	const attrFlag = item.attrs?.tomboyTrailingNewline;
	const hasTrailingNewline =
		typeof attrFlag === 'boolean' ? attrFlag : !isLastTopLevel;

	if (hasNestedList) {
		// Tomboy inserts '\n' between the item's text and its nested list.
		// If the source had marks on that separator '\n'
		// (e.g. `<datetime>\n</datetime>`), re-wrap it.
		result += trailingMarks ? wrapWithMarks('\n', trailingMarks) : '\n';
		for (const child of children) {
			if (child.type === 'bulletList') {
				result += serializeBulletList(child, /*isTopLevel=*/ false);
			}
		}
		// The `\n` AFTER the nested list (before </list-item>) only appears
		// when the item explicitly had one in the source.
		if (hasTrailingNewline) result += '\n';
	} else if (hasTrailingNewline) {
		result += '\n';
	}

	result += '</list-item>';
	return result;
}

/**
 * Wrap `inner` with the given marks in outer→inner nesting order (marks as
 * stored on a PM text node are innermost-first, so we reverse).
 */
function wrapWithMarks(inner: string, marks: JSONContent[]): string {
	// marks are already outer→inner.
	const outerToInner = marks;
	let open = '';
	let close = '';
	for (const m of outerToInner) {
		const [o, c] = markToTags(m);
		open += o;
		close = c + close;
	}
	return open + inner + close;
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
		case 'tomboyDatetime':
			return ['<datetime>', '</datetime>'];
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
