import { describe, it, expect } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { buildHueDecorations } from '$lib/editor/hueNote/hueNotePlugin.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] }, text: { group: 'inline' } } });
const docOf = (lines: string[]) => schema.node('doc', null, lines.map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : [])));
const UUID = '11111111-2222-3333-4444-555555555555';

describe('buildHueDecorations', () => {
  it('one widget for a bulb note', () => {
    const set = buildHueDecorations(docOf(['조명::거실', `light:${UUID}`]));
    expect(set.find().length).toBe(1);
  });
  it('one widget for a room note with key hue:room:<uuid>', () => {
    const set = buildHueDecorations(docOf(['조명::거실', `room:${UUID}`]));
    expect(set.find().length).toBe(1);
    expect(set.find()[0].spec.key).toBe(`hue:room:${UUID}`);
  });
  it('no widget for a non-hue note', () => {
    expect(buildHueDecorations(docOf(['그냥 노트', 'hello'])).find().length).toBe(0);
  });
});
