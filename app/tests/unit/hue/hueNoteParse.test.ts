import { describe, it, expect } from 'vitest';
import { parseHueNote } from '$lib/hue/hueNoteParse.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const ROOM_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

describe('parseHueNote', () => {
  it('bulb', () => expect(parseHueNote('조명::거실 등', `light:${UUID}`)).toEqual({ kind: 'bulb', lightId: UUID }));
  it('master', () => expect(parseHueNote('조명::전체', '')).toEqual({ kind: 'master' }));
  it('no prefix', () => expect(parseHueNote('거실 등', `light:${UUID}`)).toBeNull());
  it('unknown signature', () => expect(parseHueNote('조명::뭐', 'hello')).toBeNull());
  it('룸', () => expect(parseHueNote('조명::거실', `room:${ROOM_UUID}`)).toEqual({ kind: 'room', roomId: ROOM_UUID }));
  it('zone:<uuid> → kind zone', () => {
    expect(parseHueNote('조명::거실존', 'zone:11111111-2222-3333-4444-555555555555'))
      .toEqual({ kind: 'zone', zoneId: '11111111-2222-3333-4444-555555555555' });
  });
  it('잘못된 zone sig → null', () => {
    expect(parseHueNote('조명::x', 'zone:not-a-uuid')).toBeNull();
  });
});
