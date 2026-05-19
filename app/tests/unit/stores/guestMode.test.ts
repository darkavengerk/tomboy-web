import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTokenMock = vi.fn();
vi.mock('$lib/sync/dropboxClient.js', () => ({
  getFreshAccessToken: () => getTokenMock(),
  isAuthenticated: () => !!localStorage.getItem('tomboy-dropbox-access-token')
}));

import { mode, GUEST_NAME_KEY } from '$lib/stores/guestMode.svelte.js';

describe('guestMode.detectAndSet', () => {
  beforeEach(() => {
    getTokenMock.mockReset();
    localStorage.clear();
  });

  it('detects host when dropbox token exists', async () => {
    getTokenMock.mockResolvedValue('dbx-tok');
    localStorage.setItem(GUEST_NAME_KEY, '철수');
    await mode.detectAndSet();
    expect(mode.value).toBe('host');
  });

  it('detects guest when no token but name set', async () => {
    getTokenMock.mockResolvedValue(null);
    localStorage.setItem(GUEST_NAME_KEY, '철수');
    await mode.detectAndSet();
    expect(mode.value).toBe('guest');
  });

  it('detects visitor when neither', async () => {
    getTokenMock.mockResolvedValue(null);
    await mode.detectAndSet();
    expect(mode.value).toBe('visitor');
  });
});

describe('guestMode initial value (module-load detection)', () => {
  // These tests exercise the SYNCHRONOUS init path that runs at module load.
  // We re-import the module after seeding localStorage so the initial $state
  // is computed against the fresh storage state.
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('initializes to host synchronously when access token exists', async () => {
    localStorage.setItem('tomboy-dropbox-access-token', 'tok');
    const { mode: m } = await import('$lib/stores/guestMode.svelte.js');
    expect(m.value).toBe('host');
  });

  it('initializes to guest synchronously when guest name exists but no token', async () => {
    localStorage.setItem('tomboy.guestName', '철수');
    const { mode: m } = await import('$lib/stores/guestMode.svelte.js');
    expect(m.value).toBe('guest');
  });

  it('initializes to visitor when neither token nor guest name present', async () => {
    const { mode: m } = await import('$lib/stores/guestMode.svelte.js');
    expect(m.value).toBe('visitor');
  });

  it('prefers host over guest when both token and guest name present', async () => {
    localStorage.setItem('tomboy-dropbox-access-token', 'tok');
    localStorage.setItem('tomboy.guestName', '철수');
    const { mode: m } = await import('$lib/stores/guestMode.svelte.js');
    expect(m.value).toBe('host');
  });
});
