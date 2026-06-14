// app/tests/unit/editor/linkifyDocJson.test.ts
import { describe, it, expect } from 'vitest';
import { addInternalLinksForTitle } from '$lib/editor/autoLink/linkifyDocJson.js';
import type { JSONContent } from '@tiptap/core';

const para = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : []
});
const doc = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks });

const linkMark = (target: string) => ({ type: 'tomboyInternalLink', attrs: { target } });

describe('addInternalLinksForTitle', () => {
  it('links a whole-word match in a body paragraph', () => {
    const input = doc(para('Title line'), para('see Foo here'));
    const { docJson, changed } = addInternalLinksForTitle(input, 'Foo', 'g-foo');
    expect(changed).toBe(true);
    const inline = (docJson.content![1].content!) as JSONContent[];
    // 'see ' | 'Foo'(linked) | ' here'
    const linked = inline.find((n) => n.marks?.some((m) => m.type === 'tomboyInternalLink'));
    expect(linked?.text).toBe('Foo');
    expect(linked?.marks?.[0].attrs).toEqual({ target: 'Foo' });
  });

  it('no-ops on sub-word and on absence', () => {
    expect(addInternalLinksForTitle(doc(para('t'), para('Foobar')), 'Foo', 'g').changed).toBe(false);
    expect(addInternalLinksForTitle(doc(para('t'), para('nothing')), 'Foo', 'g').changed).toBe(false);
  });

  it('is idempotent when the span already carries the mark', () => {
    const pre = doc(para('t'), { type: 'paragraph', content: [
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'Foo', marks: [linkMark('Foo')] }
    ]});
    expect(addInternalLinksForTitle(pre, 'Foo', 'g').changed).toBe(false);
  });

  it('skips the title line only when the doc has a body', () => {
    expect(addInternalLinksForTitle(doc(para('Foo')), 'Foo', 'g').changed).toBe(true); // single block → link
    expect(addInternalLinksForTitle(doc(para('Foo'), para('x')), 'Foo', 'g')
      .docJson.content![0].content![0].marks).toBeUndefined(); // title line untouched
  });

  it('skips matches under a suppressed mark', () => {
    const input = doc(para('t'), para('Foo', [{ type: 'tomboyMonospace' }]));
    expect(addInternalLinksForTitle(input, 'Foo', 'g').changed).toBe(false);
  });

  it('recurses into list items', () => {
    const li = { type: 'bulletList', content: [
      { type: 'listItem', content: [para('Foo')] }
    ]};
    const { changed, docJson } = addInternalLinksForTitle(doc(para('t'), li), 'Foo', 'g');
    expect(changed).toBe(true);
    const liPara = ((docJson.content![1].content![0] as JSONContent).content![0] as JSONContent);
    expect(liPara.content!.some((n) => n.marks?.some((m) => m.type === 'tomboyInternalLink'))).toBe(true);
  });

  it('links a match spanning two text nodes with different base marks', () => {
    // 'Foo' straddles a bold node ('Fo') and an italic node ('o').
    const input = doc(para('t'), { type: 'paragraph', content: [
      { type: 'text', text: 'Fo', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'o', marks: [{ type: 'italic' }] }
    ]});
    const { changed, docJson } = addInternalLinksForTitle(input, 'Foo', 'g');
    expect(changed).toBe(true);
    const inline = docJson.content![1].content! as JSONContent[];
    // Each original node keeps its own base mark AND gains the link mark.
    const fo = inline.find((n) => n.text === 'Fo');
    const o = inline.find((n) => n.text === 'o');
    const names = (n?: JSONContent) => (n?.marks ?? []).map((m) => m.type).sort();
    expect(names(fo)).toEqual(['bold', 'tomboyInternalLink']);
    expect(names(o)).toEqual(['italic', 'tomboyInternalLink']);
  });

  it('links every match when a title occurs multiple times in one run', () => {
    const input = doc(para('t'), para('Foo and Foo again'));
    const { changed, docJson } = addInternalLinksForTitle(input, 'Foo', 'g');
    expect(changed).toBe(true);
    const inline = docJson.content![1].content! as JSONContent[];
    const linkedTexts = inline
      .filter((n) => n.marks?.some((m) => m.type === 'tomboyInternalLink'))
      .map((n) => n.text);
    expect(linkedTexts).toEqual(['Foo', 'Foo']); // two distinct linked spans, middle text unlinked
  });
});
