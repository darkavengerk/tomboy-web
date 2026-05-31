import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractLinkTargets,
  updateNote,
  getSourcesFor,
  clear,
  __test__getForward,
  __test__getBackward
} from '$lib/core/backlinkIndex.js';

function assertSymmetric() {
  const fwd = __test__getForward();
  const bwd = __test__getBackward();
  for (const [guid, titles] of fwd) {
    for (const t of titles) {
      expect(bwd.get(t)?.has(guid), `forward ${guid}→${t} missing in backward`).toBe(true);
    }
  }
  for (const [title, guids] of bwd) {
    expect(guids.size, `backward ${title} has empty set — should have been deleted`).toBeGreaterThan(0);
    for (const g of guids) {
      expect(fwd.get(g)?.has(title), `backward ${title}→${g} missing in forward`).toBe(true);
    }
  }
}

function noteContent(...targets: string[]): string {
  const marks = targets
    .map((t) => `<link:internal>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</link:internal>`)
    .join(' ');
  return `<note-content version="0.1">Body ${marks} done</note-content>`;
}

describe('extractLinkTargets', () => {
  it('finds <link:internal> marks', () => {
    expect(extractLinkTargets('<a><link:internal>foo</link:internal></a>')).toEqual(new Set(['foo']));
  });
  it('finds <link:broken> marks', () => {
    expect(extractLinkTargets('<a><link:broken>bar</link:broken></a>')).toEqual(new Set(['bar']));
  });
  it('unescapes &amp; / &lt; / &gt;', () => {
    const xml = '<link:internal>a &amp; b</link:internal> <link:internal>1 &lt; 2</link:internal>';
    expect(extractLinkTargets(xml)).toEqual(new Set(['a & b', '1 < 2']));
  });
  it('dedupes identical targets within one note', () => {
    const xml = '<link:internal>foo</link:internal><link:internal>foo</link:internal>';
    expect(extractLinkTargets(xml)).toEqual(new Set(['foo']));
  });
  it('returns empty set when no marks', () => {
    expect(extractLinkTargets('plain text')).toEqual(new Set());
  });
});

describe('updateNote / getSourcesFor', () => {
  beforeEach(() => clear());

  it('adds entries on first putNote', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));
    expect(getSourcesFor('B')).toEqual(new Set(['g1']));
    expect(getSourcesFor('C')).toBeUndefined();
    assertSymmetric();
  });

  it('multiple sources share a title', () => {
    updateNote('g1', noteContent('A'), false);
    updateNote('g2', noteContent('A'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1', 'g2']));
    assertSymmetric();
  });

  it('removes target when no longer referenced', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g1', noteContent('A'), false);
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));
    expect(getSourcesFor('B')).toBeUndefined();
    assertSymmetric();
  });

  it('add and remove in same call (mixed diff)', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g1', noteContent('B', 'C'), false);
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toEqual(new Set(['g1']));
    expect(getSourcesFor('C')).toEqual(new Set(['g1']));
    assertSymmetric();
  });

  it('deleted=true purges all entries for the guid', () => {
    updateNote('g1', noteContent('A', 'B'), false);
    updateNote('g2', noteContent('A'), false);
    updateNote('g1', '<note-content version="0.1">deleted</note-content>', true);
    expect(getSourcesFor('A')).toEqual(new Set(['g2']));
    expect(getSourcesFor('B')).toBeUndefined();
    expect(__test__getForward().has('g1')).toBe(false);
    assertSymmetric();
  });

  it('repeated identical updateNote is a no-op', () => {
    updateNote('g1', noteContent('A'), false);
    const fwdSize = __test__getForward().size;
    const bwdSize = __test__getBackward().size;
    updateNote('g1', noteContent('A'), false);
    expect(__test__getForward().size).toBe(fwdSize);
    expect(__test__getBackward().size).toBe(bwdSize);
    assertSymmetric();
  });

  it('handles xml-escaped titles consistently', () => {
    const xml = '<note-content><link:internal>a &amp; b</link:internal></note-content>';
    updateNote('g1', xml, false);
    expect(getSourcesFor('a & b')).toEqual(new Set(['g1']));
    expect(getSourcesFor('a &amp; b')).toBeUndefined();
    assertSymmetric();
  });
});

describe('clear', () => {
  it('empties both maps', () => {
    updateNote('g1', noteContent('A'), false);
    updateNote('g2', noteContent('B'), false);
    clear();
    expect(__test__getForward().size).toBe(0);
    expect(__test__getBackward().size).toBe(0);
    expect(getSourcesFor('A')).toBeUndefined();
  });
});

import {
  installBacklinkIndex,
  ensureBacklinkIndexReady
} from '$lib/core/backlinkIndex.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { vi } from 'vitest';

describe('install / ensureReady', () => {
  beforeEach(() => {
    clear();
    vi.restoreAllMocks();
  });

  it('initFromAllNotes scans IDB once, skipping deleted', async () => {
    const notes = [
      { guid: 'g1', xmlContent: noteContent('A'), deleted: false },
      { guid: 'g2', xmlContent: noteContent('A', 'B'), deleted: false },
      { guid: 'g3', xmlContent: noteContent('Z'), deleted: true }
    ];
    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValue(
      notes as never
    );
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toEqual(new Set(['g1', 'g2']));
    expect(getSourcesFor('B')).toEqual(new Set(['g2']));
    expect(getSourcesFor('Z')).toBeUndefined();
  });

  it('ensureBacklinkIndexReady before install returns resolved promise', async () => {
    await expect(ensureBacklinkIndexReady()).resolves.toBeUndefined();
  });

  it('install after explicit clear rebuilds from fresh IDB state', async () => {
    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValueOnce(
      [{ guid: 'g1', xmlContent: noteContent('A'), deleted: false }] as never
    );
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toEqual(new Set(['g1']));

    vi.spyOn(noteStore, 'getAllNotesIncludingTemplates').mockResolvedValueOnce(
      [{ guid: 'g2', xmlContent: noteContent('B'), deleted: false }] as never
    );
    clear();
    installBacklinkIndex();
    await ensureBacklinkIndexReady();
    expect(getSourcesFor('A')).toBeUndefined();
    expect(getSourcesFor('B')).toEqual(new Set(['g2']));
  });
});
