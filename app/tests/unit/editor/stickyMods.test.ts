import { describe, it, expect } from 'vitest';
import {
  computeStickyKeySequence,
  applyStickyToText,
  type StickyMods
} from '$lib/editor/terminal/stickyMods.js';

function ev(key: string): KeyboardEvent {
  return { key } as unknown as KeyboardEvent;
}

const NONE: StickyMods = { ctrl: false, alt: false, shift: false };
const CTRL: StickyMods = { ctrl: true, alt: false, shift: false };
const ALT: StickyMods = { ctrl: false, alt: true, shift: false };
const SHIFT: StickyMods = { ctrl: false, alt: false, shift: true };
const CTRL_ALT: StickyMods = { ctrl: true, alt: true, shift: false };
const CTRL_SHIFT: StickyMods = { ctrl: true, alt: false, shift: true };

describe('computeStickyKeySequence — letter', () => {
  it('Ctrl + l → \\x0c', () => {
    expect(computeStickyKeySequence(ev('l'), CTRL)).toBe('\x0c');
  });

  it('Ctrl + L (uppercase) → \\x0c', () => {
    expect(computeStickyKeySequence(ev('L'), CTRL)).toBe('\x0c');
  });

  it('Ctrl + a → \\x01', () => {
    expect(computeStickyKeySequence(ev('a'), CTRL)).toBe('\x01');
  });

  it('Alt + a → \\x1ba', () => {
    expect(computeStickyKeySequence(ev('a'), ALT)).toBe('\x1ba');
  });

  it('Alt + A (uppercase preserved) → \\x1bA', () => {
    expect(computeStickyKeySequence(ev('A'), ALT)).toBe('\x1bA');
  });

  it('Shift + a → A', () => {
    expect(computeStickyKeySequence(ev('a'), SHIFT)).toBe('A');
  });

  it('Ctrl+Alt + l → \\x1b\\x0c', () => {
    expect(computeStickyKeySequence(ev('l'), CTRL_ALT)).toBe('\x1b\x0c');
  });

  it('Ctrl+Shift + h → \\x08', () => {
    expect(computeStickyKeySequence(ev('h'), CTRL_SHIFT)).toBe('\x08');
  });
});

describe('computeStickyKeySequence — printable non-letter', () => {
  it('Alt + . → \\x1b.', () => {
    expect(computeStickyKeySequence(ev('.'), ALT)).toBe('\x1b.');
  });

  it('Alt + 1 → \\x1b1', () => {
    expect(computeStickyKeySequence(ev('1'), ALT)).toBe('\x1b1');
  });

  it('Ctrl + . → null (Ctrl+printable not supported)', () => {
    expect(computeStickyKeySequence(ev('.'), CTRL)).toBeNull();
  });

  it('Shift + 1 → "1" (shifted char already in event.key)', () => {
    expect(computeStickyKeySequence(ev('1'), SHIFT)).toBe('1');
  });
});

describe('computeStickyKeySequence — special keys', () => {
  it('Alt + Enter → \\x1b\\r', () => {
    expect(computeStickyKeySequence(ev('Enter'), ALT)).toBe('\x1b\r');
  });

  it('Alt + Backspace → \\x1b\\x7f', () => {
    expect(computeStickyKeySequence(ev('Backspace'), ALT)).toBe('\x1b\x7f');
  });

  it('Alt + Escape → \\x1b\\x1b', () => {
    expect(computeStickyKeySequence(ev('Escape'), ALT)).toBe('\x1b\x1b');
  });

  it('Alt + Tab → \\x1b\\t', () => {
    expect(computeStickyKeySequence(ev('Tab'), ALT)).toBe('\x1b\t');
  });

  it('Ctrl + Enter → null', () => {
    expect(computeStickyKeySequence(ev('Enter'), CTRL)).toBeNull();
  });

  it('Ctrl + Tab → null', () => {
    expect(computeStickyKeySequence(ev('Tab'), CTRL)).toBeNull();
  });

  it('Ctrl + ArrowLeft → null', () => {
    expect(computeStickyKeySequence(ev('ArrowLeft'), CTRL)).toBeNull();
  });
});

describe('computeStickyKeySequence — armed 없음', () => {
  it('no mods + l → null', () => {
    expect(computeStickyKeySequence(ev('l'), NONE)).toBeNull();
  });
});

describe('applyStickyToText', () => {
  it('Ctrl + "l" → "\\x0c"', () => {
    expect(applyStickyToText('l', CTRL)).toBe('\x0c');
  });

  it('Ctrl + "ls" → "\\x0cs" (first char transformed)', () => {
    expect(applyStickyToText('ls', CTRL)).toBe('\x0cs');
  });

  it('Alt + "." → "\\x1b."', () => {
    expect(applyStickyToText('.', ALT)).toBe('\x1b.');
  });

  it('Ctrl + "1ls" → null (first char not supported)', () => {
    expect(applyStickyToText('1ls', CTRL)).toBeNull();
  });

  it('no mods + "l" → null', () => {
    expect(applyStickyToText('l', NONE)).toBeNull();
  });

  it('any mods + "" → null', () => {
    expect(applyStickyToText('', CTRL)).toBeNull();
  });
});
