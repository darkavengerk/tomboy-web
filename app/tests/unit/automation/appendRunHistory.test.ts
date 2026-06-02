import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyListItem } from '$lib/editor/extensions/TomboyListItem.js';
import { TomboyParagraph } from '$lib/editor/extensions/TomboyParagraph.js';
import type { JSONContent } from '@tiptap/core';
import { appendRunHistory } from '$lib/automation/appendRunHistory.js';

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });

function makeEditor(content: JSONContent): Editor {
  ed = new Editor({
    extensions: [
      StarterKit.configure({ paragraph: false, listItem: false }),
      TomboyParagraph,
      TomboyListItem
    ],
    content
  });
  return ed;
}

/** Collect the first-paragraph text of each listItem in the first bulletList. */
function logTexts(doc: JSONContent): string[] {
  const list = (doc.content ?? []).find((n) => n.type === 'bulletList');
  if (!list) return [];
  return (list.content ?? []).map((li) => {
    const p = (li.content ?? []).find((c) => c.type === 'paragraph');
    return (p?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
  });
}

const titleOnly: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '자동화::loc-history' }] }] };

function withList(items: string[]): JSONContent {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '자동화::loc-history' }] },
      {
        type: 'bulletList',
        content: items.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }))
      }
    ]
  };
}

describe('appendRunHistory', () => {
  it('creates a list when none exists', () => {
    const editor = makeEditor(titleOnly);
    appendRunHistory(editor.view, 'E1');
    expect(logTexts(editor.getJSON())).toEqual(['E1']);
  });

  it('prepends newest first', () => {
    const editor = makeEditor(withList(['old1', 'old2']));
    appendRunHistory(editor.view, 'NEW');
    expect(logTexts(editor.getJSON())).toEqual(['NEW', 'old1', 'old2']);
  });

  it('caps to N items, dropping the oldest', () => {
    const editor = makeEditor(withList(['a', 'b', 'c']));
    appendRunHistory(editor.view, 'NEW', 3);
    expect(logTexts(editor.getJSON())).toEqual(['NEW', 'a', 'b']);
  });
});
