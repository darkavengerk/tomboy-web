import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTokenMock = vi.fn();
vi.mock('$lib/sync/dropboxClient.js', () => ({
  getFreshAccessToken: () => getTokenMock()
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
