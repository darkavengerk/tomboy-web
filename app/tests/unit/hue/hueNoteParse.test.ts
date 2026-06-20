import { describe, it, expect } from 'vitest';
import { parseHueNote, extractMembershipTitles } from '$lib/hue/hueNoteParse.js';
import { Schema } from '@tiptap/pm/model';

const UUID = '11111111-2222-3333-4444-555555555555';
const ROOM_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

describe('parseHueNote', () => {
  it('bulb', () => expect(parseHueNote('조명::거실 등', `light:${UUID}`)).toEqual({ kind: 'bulb', lightId: UUID }));
  it('zone with id', () => expect(parseHueNote('조명::침실', `zone:${UUID}`)).toEqual({ kind: 'zone', zoneId: UUID }));
  it('zone not yet created', () => expect(parseHueNote('조명::침실', 'zone')).toEqual({ kind: 'zone', zoneId: null }));
  it('master', () => expect(parseHueNote('조명::전체', '')).toEqual({ kind: 'master' }));
  it('no prefix', () => expect(parseHueNote('거실 등', `light:${UUID}`)).toBeNull());
  it('unknown signature', () => expect(parseHueNote('조명::뭐', 'hello')).toBeNull());
  it('룸', () => expect(parseHueNote('조명::거실', `room:${ROOM_UUID}`)).toEqual({ kind: 'room', roomId: ROOM_UUID }));
});

const schema = new Schema({
  nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] }, text: { group: 'inline' } },
  marks: { tomboyInternalLink: { attrs: { target: {}, broken: { default: false } }, toDOM: () => ['a', 0] } }
});

describe('extractMembershipTitles', () => {
  it('collects link targets in order, deduped', () => {
    const link = (t: string) => schema.text(t, [schema.marks.tomboyInternalLink.create({ target: t })]);
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [link('거실 등'), schema.text(', '), link('주방 등')]),
      schema.node('paragraph', null, [link('거실 등')])
    ]);
    expect(extractMembershipTitles(doc)).toEqual(['거실 등', '주방 등']);
  });
});
