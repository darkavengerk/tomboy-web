import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const downloadMock = vi.fn();
const uploadDropboxMock = vi.fn();
const deleteTempMock = vi.fn();
const emitReloadMock = vi.fn();

vi.mock('$lib/sync/imageUpload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/sync/imageUpload.js')>();
  return {
    ...actual,
    downloadImageFromUrl: (...args: unknown[]) => downloadMock(...args),
    uploadImageToDropbox: (...args: unknown[]) => uploadDropboxMock(...args)
  };
});

vi.mock('$lib/sync/tempImageUpload.js', () => ({
  deleteTempImage: (...args: unknown[]) => deleteTempMock(...args)
}));

vi.mock('$lib/core/noteReloadBus.js', () => ({
  emitNoteReload: (...args: unknown[]) => emitReloadMock(...args)
}));

import { promoteImageToDropbox } from '$lib/sync/imagePromotion.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';

const DROPBOX = 'https://www.dropbox.com/scl/y.png?raw=1';

// Each test uses a unique TEMP URL so IDB state from prior tests (which
// share the same fake-indexeddb instance) doesn't affect the scan results.
const TEMP_H = 'https://a.public.blob.vercel-storage.com/temp-images/happy.png';
const TEMP_F1 = 'https://a.public.blob.vercel-storage.com/temp-images/fail1.png';
const TEMP_F2 = 'https://a.public.blob.vercel-storage.com/temp-images/fail2.png';
const TEMP_P = 'https://a.public.blob.vercel-storage.com/temp-images/partial.png';
const TEMP_D = 'https://a.public.blob.vercel-storage.com/temp-images/delFail.png';

function noteWith(guid: string, body: string) {
  const n = createEmptyNote(guid);
  n.title = guid;
  n.xmlContent = `<note-content version="1.0">${body}</note-content>`;
  return n;
}

describe('promoteImageToDropbox', () => {
  beforeEach(async () => {
    downloadMock.mockReset();
    uploadDropboxMock.mockReset();
    deleteTempMock.mockReset();
    emitReloadMock.mockReset();
    // Don't try to reset fake-indexeddb between tests — distinct guids per test
    // avoid pollution. Each test uses a unique TEMP URL so only its own notes
    // are scanned.
  });

  it('happy path: downloads, uploads to dropbox, rewrites, deletes, reloads', async () => {
    await noteStore.putNoteSynced(noteWith('h1', `<link:url>${TEMP_H}</link:url>`));
    await noteStore.putNoteSynced(noteWith('h2', `<link:url>${TEMP_H}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['bytes'], { type: 'image/png' }));
    uploadDropboxMock.mockResolvedValue(DROPBOX);
    deleteTempMock.mockResolvedValue(undefined);

    const result = await promoteImageToDropbox(TEMP_H);

    expect(result.dropboxUrl).toBe(DROPBOX);
    expect(result.succeeded.sort()).toEqual(['h1', 'h2']);
    expect(result.failed).toEqual([]);
    expect(result.partialFailure).toBe(false);
    expect(result.vercelDeleteError).toBeNull();

    expect((await noteStore.getNote('h1'))!.xmlContent).toContain(DROPBOX);
    expect((await noteStore.getNote('h1'))!.xmlContent).not.toContain(TEMP_H);
    expect((await noteStore.getNote('h2'))!.xmlContent).toContain(DROPBOX);
    expect(deleteTempMock).toHaveBeenCalledWith(TEMP_H);
    expect(emitReloadMock).toHaveBeenCalledWith(expect.arrayContaining(['h1', 'h2']));
  });

  it('step 1 fail (fetch): no changes', async () => {
    await noteStore.putNoteSynced(noteWith('f1', `<link:url>${TEMP_F1}</link:url>`));
    downloadMock.mockRejectedValue(new Error('CORS'));

    await expect(promoteImageToDropbox(TEMP_F1)).rejects.toThrow(/CORS/);

    expect(uploadDropboxMock).not.toHaveBeenCalled();
    expect(deleteTempMock).not.toHaveBeenCalled();
    expect((await noteStore.getNote('f1'))!.xmlContent).toContain(TEMP_F1);
  });

  it('step 2 fail (dropbox upload): no changes', async () => {
    await noteStore.putNoteSynced(noteWith('f2', `<link:url>${TEMP_F2}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockRejectedValue(new Error('Dropbox 401'));

    await expect(promoteImageToDropbox(TEMP_F2)).rejects.toThrow(/Dropbox/);

    expect(deleteTempMock).not.toHaveBeenCalled();
    expect((await noteStore.getNote('f2'))!.xmlContent).toContain(TEMP_F2);
  });

  it('step 4 partial fail: succeeded notes have new URL, failed have old, blob kept', async () => {
    await noteStore.putNoteSynced(noteWith('p1', `<link:url>${TEMP_P}</link:url>`));
    await noteStore.putNoteSynced(noteWith('p2', `<link:url>${TEMP_P}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockResolvedValue(DROPBOX);

    const origPut = noteStore.putNote;
    const putSpy = vi.spyOn(noteStore, 'putNote').mockImplementation(async (n) => {
      if (n.guid === 'p2') throw new Error('IDB write failed');
      return origPut(n);
    });

    const result = await promoteImageToDropbox(TEMP_P);

    expect(result.partialFailure).toBe(true);
    expect(result.succeeded).toEqual(['p1']);
    expect(result.failed).toEqual(['p2']);
    expect(deleteTempMock).not.toHaveBeenCalled();   // blob KEPT
    expect((await noteStore.getNote('p1'))!.xmlContent).toContain(DROPBOX);
    expect((await noteStore.getNote('p2'))!.xmlContent).toContain(TEMP_P);

    putSpy.mockRestore();
  });

  it('step 6 fail (vercel delete): notes updated, blob remains, error captured', async () => {
    await noteStore.putNoteSynced(noteWith('d1', `<link:url>${TEMP_D}</link:url>`));
    downloadMock.mockResolvedValue(new Blob(['x']));
    uploadDropboxMock.mockResolvedValue(DROPBOX);
    deleteTempMock.mockRejectedValue(new Error('Blob 502'));

    const result = await promoteImageToDropbox(TEMP_D);

    expect(result.partialFailure).toBe(false);
    expect(result.succeeded).toEqual(['d1']);
    expect(result.vercelDeleteError).toContain('502');
    expect((await noteStore.getNote('d1'))!.xmlContent).toContain(DROPBOX);
  });
});
