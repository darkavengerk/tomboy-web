import type { JSONContent } from '@tiptap/core';

const PREFIX = '자동화::';

/** 제목 문자열에서 command id 추출. 자동화 노트가 아니거나 id가 비면 null. */
export function parseAutomationTitle(titleText: string): string | null {
  const text = titleText.trim();
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length).trim();
  if (!rest) return null;
  return rest.split(/\s+/)[0];
}

function paragraphText(node: JSONContent | undefined): string {
  if (!node?.content) return '';
  return node.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

export interface AutomationNoteSpec {
  commandId: string;
}

/** 노트 doc의 첫 단락(제목)을 보고 자동화 노트면 commandId 반환, 아니면 null. */
export function parseAutomationNote(doc: JSONContent): AutomationNoteSpec | null {
  const commandId = parseAutomationTitle(paragraphText(doc.content?.[0]));
  return commandId ? { commandId } : null;
}
