import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  parseRemarkableUploadNote,
  type RemarkableUploadNoteSpec
} from '$lib/remarkable/parseRemarkableUploadNote.js';
import { runRemarkableUpload } from './runRemarkableUpload.js';

export const remarkableNotePluginKey = new PluginKey<DecorationSet>('tomboyRemarkableNote');

function renderButton(view: EditorView, spec: RemarkableUploadNoteSpec): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tomboy-remarkable-upload';
  btn.contentEditable = 'false';
  btn.textContent = '📥 업로드';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '📥 업로드 중…';
    try {
      await runRemarkableUpload(view, spec);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  return btn;
}

/**
 * Extract a minimal JSONContent-compatible object from the live ProseMirror doc.
 * We only need the first 2 paragraphs (signature + optional header) for the parser.
 */
function docJson(doc: PMNode) {
  const content: { type: string; content?: { type: string; text?: string }[] }[] = [];
  doc.forEach((node) => {
    if (content.length >= 2) return;
    const text = node.textContent;
    content.push({
      type: node.type.name,
      content: text ? [{ type: 'text', text }] : []
    });
  });
  return { type: 'doc', content };
}

function buildDecorations(doc: PMNode): DecorationSet {
  const spec = parseRemarkableUploadNote(docJson(doc));
  if (!spec) return DecorationSet.empty;
  const first = doc.firstChild;
  if (!first) return DecorationSet.empty;
  // Anchor at end of the title paragraph (same convention as automationNotePlugin).
  const headerEndPos = first.nodeSize - 1;
  const widget = Decoration.widget(headerEndPos, (view) => renderButton(view, spec), {
    side: 1,
    key: `remarkable:${spec.notebook ?? '_default'}`
  });
  return DecorationSet.create(doc, [widget]);
}

export function createRemarkableNotePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: remarkableNotePluginKey,
    state: {
      init(_, { doc }): DecorationSet {
        return buildDecorations(doc);
      },
      apply(tr, old): DecorationSet {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildDecorations(tr.doc);
      }
    },
    props: {
      decorations(state): DecorationSet | undefined {
        return remarkableNotePluginKey.getState(state);
      }
    }
  });
}
