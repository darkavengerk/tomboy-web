import { describe, it, expect, vi, beforeEach } from 'vitest';

const collectionGroupMock = vi.fn();
const limitMock = vi.fn(() => ({}));
const getDocsMock = vi.fn();
const docMock = vi.fn(() => ({ id: 'main' }));
const setDocMock = vi.fn();
const getDocMock = vi.fn();
const queryMock = vi.fn((...a: unknown[]) => a);

vi.mock('firebase/firestore', () => ({
  collectionGroup: (...a: unknown[]) => collectionGroupMock(...a),
  query: (...a: unknown[]) => queryMock(...a),
  limit: (...a: unknown[]) => (limitMock as (...args: unknown[]) => unknown)(...a),
  getDocs: () => getDocsMock(),
  doc: (...a: unknown[]) => (docMock as (...args: unknown[]) => unknown)(...a),
  setDoc: (...a: unknown[]) => setDocMock(...a),
  getDoc: () => getDocMock()
}));

vi.mock('$lib/firebase/app.js', () => ({
  getFirebaseFirestore: () => ({})
}));

import {
  discoverPublicConfigForGuest,
  writePublicConfigAsHost,
  readPublicConfigForHost,
  getCachedPublicConfig,
  _resetCache
} from '$lib/sync/firebase/publicConfig.js';

beforeEach(() => {
  collectionGroupMock.mockReset();
  getDocsMock.mockReset();
  setDocMock.mockReset();
  getDocMock.mockReset();
  _resetCache();
});

describe('discoverPublicConfigForGuest', () => {
  it('returns host uid + sharedNotebooks from collectionGroup', async () => {
    getDocsMock.mockResolvedValue({
      empty: false,
      docs: [
        {
          ref: { parent: { parent: { id: 'dbx-XYZ' } } },
          data: () => ({ sharedNotebooks: ['공유A'] })
        }
      ]
    });
    const out = await discoverPublicConfigForGuest();
    expect(out).toEqual({ hostUid: 'dbx-XYZ', sharedNotebooks: ['공유A'] });
    expect(getCachedPublicConfig()).toEqual({ hostUid: 'dbx-XYZ', sharedNotebooks: ['공유A'] });
  });

  it('returns null when no publicConfig exists', async () => {
    getDocsMock.mockResolvedValue({ empty: true, docs: [] });
    const out = await discoverPublicConfigForGuest();
    expect(out).toBeNull();
  });
});

describe('writePublicConfigAsHost', () => {
  it('writes with merge:true and updates cache', async () => {
    await writePublicConfigAsHost('dbx-XYZ', { sharedNotebooks: ['x'] });
    expect(setDocMock).toHaveBeenCalledWith(
      expect.anything(),
      { sharedNotebooks: ['x'] },
      { merge: true }
    );
    expect(getCachedPublicConfig()).toEqual({ hostUid: 'dbx-XYZ', sharedNotebooks: ['x'] });
  });
});

describe('readPublicConfigForHost', () => {
  it('returns sharedNotebooks from existing doc', async () => {
    getDocMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ sharedNotebooks: ['공유A'] })
    });
    const out = await readPublicConfigForHost('dbx-XYZ');
    expect(out).toEqual({ sharedNotebooks: ['공유A'] });
  });

  it('returns empty list when doc missing', async () => {
    getDocMock.mockResolvedValue({ exists: () => false });
    const out = await readPublicConfigForHost('dbx-XYZ');
    expect(out).toEqual({ sharedNotebooks: [] });
  });
});
