import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

const DEFAULT_CAP = 50;

/**
 * 자동화 노트(열린 에디터)의 로그 리스트 맨 앞에 entry를 추가한다.
 * - 첫 top-level bulletList를 로그로 본다. 없으면 제목(첫 단락) 아래에 생성.
 * - 항목 수를 cap으로 제한(오래된 것부터 제거). claudeFill처럼 라이브 dispatch.
 */
export function appendRunHistory(view: EditorView, entry: string, cap = DEFAULT_CAP): void {
  if (view.isDestroyed) return;
  const { state } = view;
  const { schema, doc } = state;
  const bulletList = schema.nodes.bulletList;
  const listItem = schema.nodes.listItem;
  const paragraph = schema.nodes.paragraph;
  if (!bulletList || !listItem || !paragraph) return;

  const para = paragraph.create(null, entry ? schema.text(entry) : null);
  const item = listItem.create(null, para);

  let listPos = -1;
  let listSize = 0;
  let listAttrs: Record<string, unknown> | null = null;
  const listChildren: PMNode[] = [];
  doc.forEach((node, offset) => {
    if (listPos === -1 && node.type.name === 'bulletList') {
      listPos = offset;
      listSize = node.nodeSize;
      listAttrs = node.attrs;
      node.forEach((c) => listChildren.push(c));
    }
  });

  const tr = state.tr;
  if (listPos !== -1) {
    const items = [item, ...listChildren].slice(0, cap);
    tr.replaceWith(listPos, listPos + listSize, bulletList.create(listAttrs, items));
  } else {
    const first = doc.firstChild;
    const insertPos = first ? first.nodeSize : 0;
    tr.insert(insertPos, bulletList.create(null, item));
  }
  view.dispatch(tr);
}
