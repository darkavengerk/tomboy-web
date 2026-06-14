import type { JSONContent } from '@tiptap/core';
import {
  findNoteByTitle,
  createNote,
  getNoteEditorContent,
  updateNoteFromEditor
} from '$lib/core/noteManager.js';
import { desktopSession } from '$lib/desktop/session.svelte.js';
import { findDataBlockRegion, csvToParagraphs } from './findDataBlockRegion.js';

export type ApplyOutcome = 'updated' | 'created';

const DATA_PREFIX = 'DATA::';

/** 노트 doc의 첫 csv 블록 본문을 새 CSV로 교체. 블록이 없으면 제목 아래에 새 블록 추가. */
export function buildUpdatedDoc(doc: JSONContent, csv: string): JSONContent {
  const content = [...(doc.content ?? [])];
  const region = findDataBlockRegion(doc);
  const body = csvToParagraphs(csv);
  if (region) {
    content.splice(region.openIdx + 1, region.closeIdx - region.openIdx - 1, ...body);
  } else {
    const fence: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '```csv' }] };
    const close: JSONContent = { type: 'paragraph', content: [{ type: 'text', text: '```' }] };
    const insertAt = content.length > 0 ? 1 : 0; // after the title line
    content.splice(insertAt, 0, fence, ...body, close);
  }
  return { ...doc, content };
}

/** DATA::<project> 노트를 찾아(없으면 생성) CSV 블록을 갱신하고 저장. */
export async function applyDataNoteCsv(project: string, csv: string): Promise<ApplyOutcome> {
  const title = DATA_PREFIX + project;
  let note = await findNoteByTitle(title);
  let outcome: ApplyOutcome = 'updated';
  if (!note) {
    note = await createNote(title);
    outcome = 'created';
  }
  const newDoc = buildUpdatedDoc(getNoteEditorContent(note), csv);
  await updateNoteFromEditor(note.guid, newDoc);
  // updateNoteFromEditor now self-emits the bus reload for this guid; we only
  // still need the desktop session channel for open NoteWindows.
  await desktopSession.reloadWindows([note.guid]);
  return outcome;
}
