/**
 * Move a temp Vercel Blob image to the Dropbox backup channel.
 *
 * Step sequence (failure points designed so the note never ends up
 * pointing at a dead URL):
 *
 *   1. fetch tempUrl bytes
 *   2. upload bytes to Dropbox → dropboxUrl
 *   3. scan local notes for tempUrl
 *   4. for each affected note: load → string-replace tempUrl→dropboxUrl
 *      → putNote (localDirty=true)
 *   5. emitNoteReload(succeeded)  — so open editors reload from IDB
 *   6. deleteTempImage(tempUrl)  — only if step 4 fully succeeded
 *
 * If step 4 partially fails: blob is KEPT so the failed notes still
 * point at a live URL; the caller can retry safely (idempotent —
 * re-running just re-uploads to Dropbox under a new path).
 */

import {
  downloadImageFromUrl,
  uploadImageToDropbox
} from './imageUpload.js';
import * as noteStore from '$lib/storage/noteStore.js';
import { emitNoteReload } from '$lib/core/noteReloadBus.js';
import { deleteTempImage } from './tempImageUpload.js';
import { formatTomboyDate } from '$lib/core/note.js';

export interface PromotionResult {
  dropboxUrl: string;
  succeeded: string[];       // guids whose xmlContent was rewritten + persisted
  failed: string[];          // guids whose persist failed; still hold old URL
  partialFailure: boolean;   // failed.length > 0
  vercelDeleteError: string | null;
}

function fileExtFromUrl(url: string): string {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(url);
  return m ? m[1].toLowerCase() : 'png';
}

function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg || `image.${fileExtFromUrl(url)}`;
  } catch {
    return `image.${fileExtFromUrl(url)}`;
  }
}

export async function promoteImageToDropbox(tempUrl: string): Promise<PromotionResult> {
  // Step 1: fetch bytes
  const blob = await downloadImageFromUrl(tempUrl);

  // Step 2: upload to Dropbox
  const file = new File([blob], fileNameFromUrl(tempUrl), {
    type: blob.type || 'image/png'
  });
  const dropboxUrl = await uploadImageToDropbox(file);

  // Step 3: find affected notes (exact string match in xmlContent)
  const all = await noteStore.getAllNotes();
  const affected = all.filter(
    (n) => !n.deleted && (n.xmlContent ?? '').includes(tempUrl)
  );

  // Step 4: rewrite each note. Defensive per-note try/catch so one failure
  // doesn't abort the rest.
  const succeeded: string[] = [];
  const failed: string[] = [];
  const now = formatTomboyDate(new Date());
  for (const note of affected) {
    try {
      const next = { ...note };
      next.xmlContent = (note.xmlContent ?? '').split(tempUrl).join(dropboxUrl);
      next.changeDate = now;
      next.metadataChangeDate = now;
      await noteStore.putNote(next);
      succeeded.push(note.guid);
    } catch {
      failed.push(note.guid);
    }
  }

  // Step 5: reload open editors for the succeeded notes
  if (succeeded.length > 0) {
    await emitNoteReload(succeeded);
  }

  const partialFailure = failed.length > 0;

  // Step 6: delete blob ONLY if every affected note was updated
  let vercelDeleteError: string | null = null;
  if (!partialFailure) {
    try {
      await deleteTempImage(tempUrl);
    } catch (err) {
      vercelDeleteError = err instanceof Error ? err.message : String(err);
    }
  }

  return { dropboxUrl, succeeded, failed, partialFailure, vercelDeleteError };
}
