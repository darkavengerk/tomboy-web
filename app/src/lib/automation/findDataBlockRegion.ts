import type { JSONContent } from '@tiptap/core';
import { detectFenceFormat, isFenceClose, type TableFormat } from '$lib/editor/tableBlock/parseTable.js';

function paragraphText(node: JSONContent | undefined): string {
  if (!node?.content) return '';
  return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

export interface DataBlockRegion {
  openIdx: number;
  closeIdx: number;
  format: TableFormat;
}

/** 노트 doc.content에서 첫 csv/tsv 펜스 블록의 인덱스. 없거나 안 닫혔으면 null. */
export function findDataBlockRegion(doc: JSONContent): DataBlockRegion | null {
  const nodes = doc.content ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const fmt = detectFenceFormat(paragraphText(nodes[i]));
    if (!fmt) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      if (isFenceClose(paragraphText(nodes[j]))) {
        return { openIdx: i, closeIdx: j, format: fmt };
      }
    }
    return null; // opened but never closed
  }
  return null;
}

/** CSV 문자열을 단락 노드 배열로(한 줄 = 한 단락, 끝 개행 제거). */
export function csvToParagraphs(csv: string): JSONContent[] {
  return csv
    .replace(/\n$/, '')
    .split('\n')
    .map((line) =>
      line === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    );
}
