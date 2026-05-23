import type { JSONContent } from '@tiptap/core';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;

function isImageUrl(href: string): boolean {
  return IMG_EXT_RE.test(href);
}

function paragraphInlines(block: JSONContent): JSONContent[] {
  return Array.isArray(block.content) ? block.content : [];
}

function paragraphText(block: JSONContent): string {
  let out = '';
  for (const c of paragraphInlines(block)) {
    if (c.type === 'text') out += c.text ?? '';
    else if (c.type === 'hardBreak') out += '\n';
  }
  return out;
}

/**
 * Skip the header region of a chat note doc. Returns the doc.content index
 * where turn paragraphs start (the first blank paragraph after the
 * signature, or `doc.content.length` if no blank seen).
 *
 * Header layout:
 *   [0] title  [1] signature  [2..N] header lines  [N+1] blank  → turns at N+2
 * Transient (title == signature):
 *   [0] signature  [1..N] header lines  [N+1] blank  → turns at N+2
 */
function findTurnStart(doc: JSONContent): number {
  if (!Array.isArray(doc.content) || doc.content.length === 0) return 0;
  // Skip title (index 0). Signature is at 1 (or 0 in transient state).
  // We scan from index 1 upward looking for the first blank paragraph.
  for (let i = 1; i < doc.content.length; i++) {
    if (paragraphText(doc.content[i]) === '') return i + 1;
  }
  return doc.content.length;
}

/** Append a text run to the last block if that's a text block; else push a new text block. */
function appendText(blocks: ContentBlock[], text: string): void {
  if (text === '') return;
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    last.text += text;
  } else {
    blocks.push({ type: 'text', text });
  }
}

/** Convert a stream of inline nodes (across one or more paragraphs) into ContentBlock[]. */
function inlinesToBlocks(inlineStream: JSONContent[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const node of inlineStream) {
    if (node.type === 'hardBreak') {
      appendText(blocks, '\n');
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = (node.marks ?? []) as Array<{ type: string; attrs?: { href?: string } }>;
    const urlMark = marks.find((m) => m.type === 'tomboyUrlLink');
    const href = urlMark?.attrs?.href ?? node.text ?? '';
    if (urlMark && isImageUrl(href)) {
      blocks.push({ type: 'image', source: { type: 'url', url: href } });
    } else {
      appendText(blocks, node.text ?? '');
    }
  }
  return blocks;
}

/**
 * Build Anthropic-format messages array from a chat note doc.
 *
 * Walks paragraphs after the signature/header region. Q:/A: prefixed
 * paragraphs start a new turn (the prefix is stripped). Subsequent
 * non-prefixed paragraphs in the same turn are joined with '\n'.
 *
 * Within a turn, inline nodes are flattened to content blocks: plain text
 * is accumulated, but a `tomboyUrlLink` mark with an image-extension href
 * becomes an `image` block (URL passed to Anthropic which fetches it
 * server-side).
 */
export function buildClaudeMessages(doc: JSONContent): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const turnStart = findTurnStart(doc);
  const blocks = Array.isArray(doc.content) ? doc.content : [];

  let currentRole: 'user' | 'assistant' | null = null;
  let currentInlines: JSONContent[] = [];

  const flush = (): void => {
    if (currentRole === null) return;
    const content = inlinesToBlocks(currentInlines);
    // An empty turn (e.g. bare "Q:") should produce a single empty text block
    // rather than an empty content array, so the message is structurally valid.
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }
    messages.push({ role: currentRole, content });
    currentRole = null;
    currentInlines = [];
  };

  for (let i = turnStart; i < blocks.length; i++) {
    const para = blocks[i];
    if (para.type !== 'paragraph') continue;
    const inlines = paragraphInlines(para);

    // Detect Q:/A: prefix on the first text inline of the paragraph.
    const firstTextInline = inlines.find((n) => n.type === 'text');
    const firstText = firstTextInline?.text ?? '';

    let newRole: 'user' | 'assistant' | null = null;
    let prefixLen = 0;
    if (firstText.startsWith('Q: ')) {
      newRole = 'user';
      prefixLen = 3;
    } else if (firstText === 'Q:') {
      newRole = 'user';
      prefixLen = 2;
    } else if (firstText.startsWith('A: ')) {
      newRole = 'assistant';
      prefixLen = 3;
    } else if (firstText === 'A:') {
      newRole = 'assistant';
      prefixLen = 2;
    }

    if (newRole !== null) {
      flush();
      currentRole = newRole;
      // Reconstruct inlines for the current turn, stripping the prefix from
      // the first text node.
      const stripped = inlines.map((n, idx) => {
        if (idx === inlines.indexOf(firstTextInline!)) {
          // Only strip from the first text inline (the one with the prefix).
          return { ...n, text: (n.text ?? '').slice(prefixLen) };
        }
        return n;
      });
      // When prefix was the entire first inline but there are other inlines
      // after it, filter out the empty leading text node (avoids a spurious
      // empty text block before an image block, for example).
      // However, if the stripped array has only one empty text node
      // (i.e. "Q:" with no following content), we KEEP it so that
      // inlinesToBlocks produces [{type:'text', text:''}] as required.
      const firstStripped = stripped[0];
      const isEmptyLeader =
        firstStripped && firstStripped.type === 'text' && firstStripped.text === '';
      const cleaned =
        isEmptyLeader && stripped.length > 1 ? stripped.slice(1) : stripped;
      currentInlines.push(...cleaned);
    } else if (currentRole !== null) {
      // Continuation paragraph — join with newline separator before its inlines.
      currentInlines.push({ type: 'hardBreak' }, ...inlines);
    }
    // Paragraphs before any Q:/A: are ignored (shouldn't happen given
    // findTurnStart, but we're defensive).
  }
  flush();

  // ChatSendBar appends an empty 'A: ' placeholder paragraph BEFORE calling
  // buildClaudeMessages — it's the response anchor that streamed deltas
  // accumulate into. That placeholder shows up as a trailing assistant turn
  // with empty content. It's not real history, drop it so consolidate sees
  // the prior user turn as the trailing one.
  if (messages.length > 0) {
    const tail = messages[messages.length - 1];
    if (
      tail.role === 'assistant' &&
      tail.content.length === 1 &&
      tail.content[0].type === 'text' &&
      tail.content[0].text === ''
    ) {
      messages.pop();
    }
  }

  return consolidateToSingleUser(messages);
}

/**
 * Claude CLI's `--input-format stream-json` only accepts user-role messages
 * (it generates assistant turns; you cannot feed prior assistant responses
 * back through stdin in `-p` mode without `--resume <session>`). To preserve
 * multi-turn context from the note while staying stateless, fold any prior
 * Q/A turns into a text prefix on the latest user turn.
 *
 * - Zero turns → []
 * - One turn (must be user, the send-bar gate guarantees this) → unchanged
 * - Multi turn → single user message: [text(history), ...latest user content]
 *
 * History text format mirrors what's in the note ("Q:" / "A:" prefixes) so
 * Claude sees the same shape the user authored.
 */
function consolidateToSingleUser(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return [];

  if (messages.length === 1) return [last];

  const lines: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    const label = m.role === 'user' ? 'Q' : 'A';
    const text = m.content
      .map((b) => (b.type === 'text' ? b.text : '[이미지]'))
      .join('');
    lines.push(`${label}: ${text}`);
  }
  const historyText = lines.join('\n\n') + '\n\nQ: ';

  return [
    {
      role: 'user',
      content: [{ type: 'text', text: historyText }, ...last.content],
    },
  ];
}
