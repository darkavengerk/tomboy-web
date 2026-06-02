import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { parseAutomationTitle } from '$lib/automation/parseAutomationNote.js';
import { runAutomationButtonClick } from './runAutomationButtonClick.js';

export const automationNotePluginKey = new PluginKey<DecorationSet>('tomboyAutomationNote');

function renderButton(view: EditorView, commandId: string): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tomboy-automation-run';
  btn.contentEditable = 'false';
  btn.textContent = '⟳ 실행';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⟳ 실행 중…';
    try {
      await runAutomationButtonClick(view, commandId);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  return btn;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const first = doc.firstChild;
  const commandId = parseAutomationTitle(first?.textContent ?? '');
  if (!first || !commandId) return DecorationSet.empty;
  // Anchor just inside the end of the title paragraph (mirrors chartBlock).
  const headerEndPos = first.nodeSize - 1;
  const widget = Decoration.widget(headerEndPos, (view) => renderButton(view, commandId), {
    side: 1,
    key: `automation:${commandId}`
  });
  return DecorationSet.create(doc, [widget]);
}

export function createAutomationNotePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: automationNotePluginKey,
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
        return automationNotePluginKey.getState(state);
      }
    }
  });
}
