import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { mount, unmount } from 'svelte';
import { parseHueNote, type HueNoteInfo } from '$lib/hue/hueNoteParse.js';
import BulbControl from './BulbControl.svelte';
import ZoneControl from './ZoneControl.svelte';
import MasterDashboard from './MasterDashboard.svelte';

export const hueNotePluginKey = new PluginKey<DecorationSet>('tomboyHueNote');

export interface HuePluginOpts { getGuid: () => string; oninternallink?: (title: string) => void; }

/** 제목(첫 노드) + 본문 첫 보이는 줄(2번째 top-level 노드)로 종류 판별, 종류별 위젯 1개를 제목 직후에. */
export function buildHueDecorations(doc: PMNode, opts?: HuePluginOpts): DecorationSet {
  const first = doc.firstChild;
  if (!first) return DecorationSet.empty;
  const title = first.textContent;
  const second = doc.childCount > 1 ? doc.child(1) : null;
  const bodyFirstLine = second?.textContent ?? '';
  const info = parseHueNote(title, bodyFirstLine);
  if (!info) return DecorationSet.empty;
  const afterTitle = first.nodeSize;
  const key = `hue:${info.kind}:${info.lightId ?? info.zoneId ?? 'master'}`;
  const widget = Decoration.widget(afterTitle, (view) => renderWidget(view, info, opts), {
    side: 1,
    key,
    destroy: (node) => (node as { _hueDestroy?: () => void })._hueDestroy?.()
  });
  return DecorationSet.create(doc, [widget]);
}

function renderWidget(view: EditorView, info: HueNoteInfo, opts?: HuePluginOpts): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hue-widget';
  host.contentEditable = 'false';
  const Comp = info.kind === 'bulb' ? BulbControl : info.kind === 'zone' ? ZoneControl : MasterDashboard;
  const props: Record<string, unknown> =
    info.kind === 'bulb' ? { lightId: info.lightId }
    : info.kind === 'zone' ? { zoneId: info.zoneId, view, getGuid: opts?.getGuid, oninternallink: opts?.oninternallink }
    : { oninternallink: opts?.oninternallink };
  const inst = mount(Comp as never, { target: host, props });
  (host as unknown as { _hueDestroy?: () => void })._hueDestroy = () => { void unmount(inst); };
  return host;
}

export function createHueNotePlugin(opts: HuePluginOpts): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: hueNotePluginKey,
    state: {
      init: (_, { doc }) => buildHueDecorations(doc, opts),
      apply: (tr, old) => (tr.docChanged ? buildHueDecorations(tr.doc, opts) : old.map(tr.mapping, tr.doc))
    },
    props: { decorations: (state) => hueNotePluginKey.getState(state) }
  });
}
