import type { JSONContent } from '@tiptap/core';
import { findTitleMatches } from './findTitleMatches.js';

const LINK_MARK = 'tomboyInternalLink';
const DEFAULT_SUPPRESS = ['tomboyUrlLink', 'tomboyMonospace', 'code'];

interface CharMeta { node: JSONContent; suppressed: boolean; hasLink: boolean; }

/**
 * Add the `tomboyInternalLink` mark to whole-word matches of `title` in `docJson`.
 * Additive only (never removes/reconciles). Pure: returns a new doc when changed,
 * otherwise the original object with `changed:false`. No ProseMirror schema needed.
 *
 * Mirrors autoLinkPlugin.applyInRange's run-building + skip rules, but reuses the
 * SAME pure `findTitleMatches`, so matching stays consistent with the live editor.
 */
export function addInternalLinksForTitle(
  docJson: JSONContent,
  title: string,
  targetGuid: string,
  suppressMarks: string[] = DEFAULT_SUPPRESS
): { docJson: JSONContent; changed: boolean } {
  const trimmed = title.trim();
  const blocks = docJson.content ?? [];
  if (!trimmed || blocks.length === 0) return { docJson, changed: false };
  const suppress = new Set(suppressMarks);
  const hasBody = blocks.length > 1;
  let changed = false;

  const isText = (n: JSONContent) => n.type === 'text';
  const hasInlineText = (n: JSONContent) => Array.isArray(n.content) && n.content.some(isText);

  // Returns a (possibly new) node; mutates nothing in place.
  function processBlock(node: JSONContent): JSONContent {
    if (hasInlineText(node)) return linkInline(node);
    if (!Array.isArray(node.content)) return node;
    const newContent = node.content.map(processBlock);
    return { ...node, content: newContent };
  }

  // Rebuild a textblock's inline content, adding the link mark on fresh matches.
  function linkInline(block: JSONContent): JSONContent {
    const inline = block.content ?? [];
    // Build runs of contiguous text nodes (split on any non-text inline node).
    let out: JSONContent[] = [];
    let run: JSONContent[] = [];
    const flush = () => {
      if (run.length) { out = out.concat(relinkRun(run)); run = []; }
    };
    for (const child of inline) {
      if (isText(child)) run.push(child);
      else { flush(); out.push(child); }
    }
    flush();
    return { ...block, content: out };
  }

  // Given consecutive text nodes, return the (possibly re-split) text nodes with
  // the link mark applied to fresh, non-suppressed, not-already-linked matches.
  function relinkRun(textNodes: JSONContent[]): JSONContent[] {
    let text = '';
    const meta: CharMeta[] = [];
    for (const n of textNodes) {
      const t = n.text ?? '';
      const marks = (n.marks ?? []) as { type: string }[];
      const suppressed = marks.some((m) => suppress.has(m.type));
      const hasLink = marks.some((m) => m.type === LINK_MARK);
      for (let i = 0; i < t.length; i++) { text += t[i]; meta.push({ node: n, suppressed, hasLink }); }
    }
    const matches = findTitleMatches(text, [{ title: trimmed, guid: targetGuid }]);
    // marked[i] = char i should receive the link mark.
    const marked = new Array(text.length).fill(false);
    for (const m of matches) {
      let ok = true;
      for (let i = m.from; i < m.to; i++) if (meta[i].suppressed || meta[i].hasLink) { ok = false; break; }
      if (!ok) continue;
      for (let i = m.from; i < m.to; i++) marked[i] = true;
      changed = true;
    }
    if (!matches.length || marked.every((v) => !v)) return textNodes; // unchanged

    // Re-emit, splitting each original text node at its node boundary AND at
    // marked/unmarked transitions, so original marks are preserved per node.
    const result: JSONContent[] = [];
    let gi = 0; // global char index
    for (const n of textNodes) {
      const t = n.text ?? '';
      let i = 0;
      while (i < t.length) {
        const want = marked[gi + i];
        let j = i;
        while (j < t.length && marked[gi + j] === want) j++;
        const piece = t.slice(i, j);
        const baseMarks = (n.marks ?? []) as JSONContent[];
        const marks = want ? [...baseMarks, { type: LINK_MARK, attrs: { target: trimmed } }] : baseMarks;
        result.push({ type: 'text', text: piece, ...(marks.length ? { marks } : {}) });
        i = j;
      }
      gi += t.length;
    }
    return result;
  }

  const newBlocks = blocks.map((b, idx) => {
    if (hasBody && idx === 0) return b; // title line — never linked
    return processBlock(b);
  });

  if (!changed) return { docJson, changed: false };
  return { docJson: { ...docJson, content: newBlocks }, changed: true };
}
