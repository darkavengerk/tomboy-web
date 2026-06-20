/**
 * Task 6 검증 — bundleBlock 이 생성하는 PMNode 구조를 parser.ts 가
 * 실제로 '묶음' 번들로 인식하는지 확인한다.
 *
 * 접근: parser.test.ts 와 동일 패턴 — 실제 Editor + parseNoteBundles 호출.
 * MasterDashboard.svelte 의 bundleBlock 로직을 여기서 직접 재현해
 * (컴포넌트를 마운트하지 않고) 순수 PMNode 빌더로 테스트한다.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TomboyInlineCheckbox } from '$lib/editor/inlineCheckbox';
import { TomboyInlineRadio } from '$lib/editor/inlineRadio';
import { TomboyInternalLink } from '$lib/editor/extensions/TomboyInternalLink.js';
import { parseNoteBundles } from '$lib/editor/noteBundle/parser.js';
import type { Schema, Node as PMNode } from '@tiptap/pm/model';

// BUNDLE_RE — parser.ts 내부 상수의 byte-identical 복사본
const BUNDLE_RE_LOCAL = /^\s*(?:노트\s*)?묶음:(\d+)?(?::(\d+))?\s*$/;

let currentEditor: Editor | null = null;
afterEach(() => {
  currentEditor?.destroy();
  currentEditor = null;
});

function makeEditor(content: object): Editor {
  currentEditor = new Editor({
    extensions: [
      StarterKit,
      ...TomboyInlineCheckbox,
      ...TomboyInlineRadio,
      TomboyInternalLink.configure({
        getTitles: () => [],
        getCurrentGuid: () => null,
        deferred: true
      })
    ],
    content
  });
  return currentEditor;
}

/**
 * MasterDashboard.svelte 의 bundleBlock 로직 복사본.
 * 컴포넌트 없이 순수 PMNode 빌더로 테스트.
 */
function bundleBlock(schema: Schema, label: string, titles: string[]): PMNode[] {
  const cb = schema.nodes.inlineCheckbox;
  const li = schema.nodes.listItem;
  const bl = schema.nodes.bulletList;
  const p = schema.nodes.paragraph;
  const link = schema.marks.tomboyInternalLink;

  const head = p.create(null, [
    schema.text(label),
    cb.create({ checked: false }),
    schema.text('묶음:50')
  ]);

  const items = titles.map((t) =>
    li.create(null, p.create(null, [schema.text(t, [link.create({ target: t })])]))
  );
  const list = bl.create(null, items.length ? items : [li.create(null, p.create())]);
  return [head, list];
}

describe('bundleBlock — BUNDLE_RE 호환성', () => {
  it('체크박스 뒤 텍스트 "묶음:50" 이 BUNDLE_RE 에 매칭됨', () => {
    expect(BUNDLE_RE_LOCAL.test('묶음:50')).toBe(true);
  });

  it('"전구: " prefix 의 trimmed 형태("전구:")가 ":" 로 끝나 파서 허용 조건 충족', () => {
    const prefix = '전구: ';
    const trimmed = prefix.trim();
    expect(trimmed.endsWith(':')).toBe(true);
  });

  it('"방: " prefix 도 마찬가지로 ":" 로 끝남', () => {
    const prefix = '방: ';
    expect(prefix.trim().endsWith(':')).toBe(true);
  });

  it('"존: " prefix 도 ":" 로 끝남', () => {
    expect('존: '.trim().endsWith(':')).toBe(true);
  });
});

describe('bundleBlock — parseNoteBundles 통합 인식', () => {
  it('전구 묶음 블록이 kind=bundle 로 인식되고 entries 에 링크 목록 담김', () => {
    const ed = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '조명::전체' }] }
      ]
    });

    const schema = ed.schema;
    const blocks = bundleBlock(schema, '전구: ', ['조명::메인등', '조명::부엌등']);

    // 제목 뒤에 두 블록(head + list) 삽입
    const { tr } = ed.state;
    const from = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(tr.replaceWith(from, ed.state.doc.content.size, blocks));

    const bundles = parseNoteBundles(ed.state.doc);
    expect(bundles).toHaveLength(1);
    const b = bundles[0];
    expect(b.kind).toBe('bundle');
    expect(b.heightPct).toBe(50);
    expect(b.entries.map((e) => e.title)).toEqual(['조명::메인등', '조명::부엌등']);
    expect(b.entries.every((e) => e.category === null)).toBe(true);
  });

  it('전구 묶음 + 방 묶음 두 블록 연속 삽입 시 두 번들 모두 인식됨', () => {
    const ed = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '조명::전체' }] }
      ]
    });

    const schema = ed.schema;
    const allBlocks = [
      ...bundleBlock(schema, '전구: ', ['조명::거실등']),
      ...bundleBlock(schema, '방: ', ['조명::거실'])
    ];

    const { tr } = ed.state;
    const from = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(tr.replaceWith(from, ed.state.doc.content.size, allBlocks));

    const bundles = parseNoteBundles(ed.state.doc);
    expect(bundles).toHaveLength(2);
    expect(bundles[0].kind).toBe('bundle');
    expect(bundles[0].entries.map((e) => e.title)).toEqual(['조명::거실등']);
    expect(bundles[1].kind).toBe('bundle');
    expect(bundles[1].entries.map((e) => e.title)).toEqual(['조명::거실']);
  });

  it('전구+방+존 3블록 연속 삽입 시 세 번들 모두 인식됨', () => {
    const ed = makeEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '조명::전체' }] }]
    });
    const schema = ed.schema;
    const allBlocks = [
      ...bundleBlock(schema, '전구: ', ['조명::거실등']),
      ...bundleBlock(schema, '방: ', ['조명::거실']),
      ...bundleBlock(schema, '존: ', ['조명::거실존'])
    ];
    const { tr } = ed.state;
    const from = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(tr.replaceWith(from, ed.state.doc.content.size, allBlocks));

    const bundles = parseNoteBundles(ed.state.doc);
    expect(bundles).toHaveLength(3);
    expect(bundles[2].entries.map((e) => e.title)).toEqual(['조명::거실존']);
  });

  it('titles 빈 배열이어도 번들로 인식됨(빈 리스트 허용)', () => {
    const ed = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '조명::전체' }] }
      ]
    });

    const schema = ed.schema;
    const blocks = bundleBlock(schema, '전구: ', []);

    const { tr } = ed.state;
    const from = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(tr.replaceWith(from, ed.state.doc.content.size, blocks));

    const bundles = parseNoteBundles(ed.state.doc);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].kind).toBe('bundle');
    expect(bundles[0].entries).toEqual([]);
  });
});
