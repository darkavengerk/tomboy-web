import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

const listMock = vi.fn();
vi.mock('$lib/sync/tempImageUpload.js', () => ({
  listTempImages: () => listMock()
}));

import {
  classifyImageUrl,
  scanNotesForImages,
  loadImageInventory
} from '$lib/sync/imageInventory.js';
import { putNoteSynced } from '$lib/storage/noteStore.js';
import { createEmptyNote } from '$lib/core/note.js';

function noteWith(guid: string, title: string, body: string) {
  const n = createEmptyNote(guid);
  n.title = title;
  n.xmlContent = `<note-content version="1.0">${body}</note-content>`;
  return n;
}

describe('classifyImageUrl', () => {
  const cases: Array<[string, string]> = [
    ['https://abc.public.blob.vercel-storage.com/temp-images/x.png', 'temp'],
    ['https://www.dropbox.com/scl/abc?raw=1', 'dropbox'],
    ['https://dl.dropboxusercontent.com/y.jpg', 'dropbox'],
    ['https://example.com/pic.png', 'external'],
    ['https://upload.wikimedia.org/foo.svg', 'external'],
    ['not a url', 'external']
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      expect(classifyImageUrl(url)).toBe(expected);
    });
  }
});

describe('scanNotesForImages', () => {
  it('extracts image URLs and groups by note', async () => {
    const a = noteWith(
      'g1',
      'note one',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/x.png</link:url>
       <link:url>https://www.dropbox.com/scl/y.jpg?raw=1</link:url>`
    );
    const b = noteWith(
      'g2',
      'note two',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/x.png</link:url>`
    );
    await putNoteSynced(a);
    await putNoteSynced(b);

    const result = await scanNotesForImages();
    const sharedTemp = result.find((r) => r.url.includes('temp-images/x.png'));
    expect(sharedTemp).toBeDefined();
    expect(sharedTemp!.usedIn.map((u) => u.guid).sort()).toEqual(['g1', 'g2']);

    const dropbox = result.find((r) => r.url.includes('dropbox.com'));
    expect(dropbox).toBeDefined();
    expect(dropbox!.usedIn.map((u) => u.guid)).toEqual(['g1']);
  });

  it('ignores non-image URLs', async () => {
    const a = noteWith(
      'g3',
      'note three',
      `<link:url>https://example.com/page.html</link:url>`
    );
    await putNoteSynced(a);

    const result = await scanNotesForImages();
    const nonImage = result.find((r) => r.url.includes('page.html'));
    expect(nonImage).toBeUndefined();
  });
});

describe('loadImageInventory', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it('merges note scan with Vercel list, flags orphans', async () => {
    const n = noteWith(
      'g4',
      'note',
      `<link:url>https://a.public.blob.vercel-storage.com/temp-images/used.png</link:url>`
    );
    await putNoteSynced(n);

    listMock.mockResolvedValue({
      items: [
        {
          url: 'https://a.public.blob.vercel-storage.com/temp-images/used.png',
          pathname: 'temp-images/used.png',
          size: 100,
          uploadedAt: '2026-05-27T00:00:00Z'
        },
        {
          url: 'https://a.public.blob.vercel-storage.com/temp-images/orphan.png',
          pathname: 'temp-images/orphan.png',
          size: 200,
          uploadedAt: '2026-05-27T00:00:00Z'
        }
      ],
      hasMore: false
    });

    const inv = await loadImageInventory();

    const used = inv.items.find((i) => i.url.includes('used.png'));
    expect(used).toBeDefined();
    expect(used!.storage).toBe('temp');
    expect(used!.isOrphan).toBe(false);
    expect(used!.size).toBe(100);
    expect(used!.usedIn.length).toBeGreaterThan(0);

    const orphan = inv.items.find((i) => i.url.includes('orphan.png'));
    expect(orphan).toBeDefined();
    expect(orphan!.isOrphan).toBe(true);
    expect(orphan!.usedIn).toEqual([]);

    expect(inv.listError).toBeNull();
  });

  it('returns partial result when Vercel list fails', async () => {
    listMock.mockRejectedValue(new Error('502'));
    const inv = await loadImageInventory();
    expect(inv.listError).toContain('502');
    expect(Array.isArray(inv.items)).toBe(true);
  });
});
