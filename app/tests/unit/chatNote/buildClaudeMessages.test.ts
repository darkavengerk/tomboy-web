import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { buildClaudeMessages } from '$lib/chatNote/buildClaudeMessages.js';

function textPara(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function imageLinkPara(url: string, prefix = ''): JSONContent {
  const content: JSONContent[] = [];
  if (prefix) content.push({ type: 'text', text: prefix });
  content.push({
    type: 'text',
    text: url,
    marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }],
  });
  return { type: 'paragraph', content };
}

function docFrom(...paras: JSONContent[]): JSONContent {
  return { type: 'doc', content: paras };
}

describe('buildClaudeMessages', () => {
  it('text-only Q produces single text block', () => {
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: hello'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('Q + A + Q consolidates into a single user message with history prefix', () => {
    // claude CLI's --input-format stream-json only accepts user-role messages
    // (it generates assistant turns; you can't replay assistant content as
    // input in `-p` mode). We embed history as text on the final user msg.
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: hi'),
      textPara('A: hello!'),
      textPara('Q: what is 2+2'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'Q: hi\n\nA: hello!\n\nQ: ' },
      { type: 'text', text: 'what is 2+2' },
    ]);
  });

  it('image in prior turn becomes [이미지] placeholder in history text', () => {
    const url = 'https://dropbox.com/old.png?raw=1';
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('title'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: look at ' },
            { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] },
          ],
        },
        textPara('A: I see it'),
        textPara('Q: what about now'),
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    // First content block is the history text — prior image becomes a placeholder
    const first = msgs[0].content[0];
    expect(first.type).toBe('text');
    expect((first as { text: string }).text).toContain('look at [이미지]');
    expect((first as { text: string }).text).toContain('A: I see it');
    // Last block is the new user turn's content
    expect(msgs[0].content[msgs[0].content.length - 1]).toEqual({
      type: 'text',
      text: 'what about now',
    });
  });

  it('image URL in Q produces image content block', () => {
    const d = docFrom(
      textPara('title'),
      textPara('claude://'),
      textPara(''),
      imageLinkPara('https://dropbox.com/scl/foo/img.png?raw=1', 'Q: '),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://dropbox.com/scl/foo/img.png?raw=1' } },
    ]);
  });

  it('text + image + text in one Q preserves order', () => {
    const url = 'https://dropbox.com/foo.jpg?raw=1';
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('title'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: look at ' },
            { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] },
            { type: 'text', text: ' and tell me' },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'look at ' },
      { type: 'image', source: { type: 'url', url } },
      { type: 'text', text: ' and tell me' },
    ]);
  });

  it('non-image URL stays as text', () => {
    const url = 'https://example.com/page';
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('title'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: see ' },
            { type: 'text', text: url, marks: [{ type: 'tomboyUrlLink', attrs: { href: url } }] },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([
      { type: 'text', text: `see ${url}` },
    ]);
  });

  it('hardBreak becomes \\n', () => {
    const d: JSONContent = {
      type: 'doc',
      content: [
        textPara('t'),
        textPara('claude://'),
        textPara(''),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Q: line 1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line 2' },
          ],
        },
      ],
    };
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'line 1\nline 2' }]);
  });

  it('multi-paragraph Q joins with \\n', () => {
    const d = docFrom(
      textPara('t'),
      textPara('claude://'),
      textPara(''),
      textPara('Q: line 1'),
      textPara('line 2'),
      textPara('line 3'),
    );
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'line 1\nline 2\nline 3' }]);
  });

  it('Q: prefix is stripped (role becomes user)', () => {
    const d = docFrom(textPara('t'), textPara('claude://'), textPara(''), textPara('Q: hello'));
    const msgs = buildClaudeMessages(d);
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(msgs[0].role).toBe('user');
  });

  it('empty trailing Q (boundary case) produces empty user content', () => {
    const d = docFrom(textPara('t'), textPara('claude://'), textPara(''), textPara('Q:'));
    const msgs = buildClaudeMessages(d);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toEqual([{ type: 'text', text: '' }]);
  });

  it('returns empty array when no turns', () => {
    const d = docFrom(textPara('t'), textPara('claude://'));
    const msgs = buildClaudeMessages(d);
    expect(msgs).toEqual([]);
  });
});
