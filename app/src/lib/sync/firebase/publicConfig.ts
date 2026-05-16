/**
 * publicConfig — host-side write + guest-side discover for shared notebook config.
 *
 * Note: This module reaches into firebase/firestore directly (like noteSyncClient.firestore.ts).
 * The CLAUDE.md "don't reach outside noteSyncClient" rule applies to note-sync paths only;
 * publicConfig is a separate boundary with its own collection and access pattern.
 */

import {
  collectionGroup,
  query,
  limit,
  getDocs,
  doc,
  setDoc,
  getDoc
} from 'firebase/firestore';
import { getFirebaseFirestore } from '$lib/firebase/app.js';

export interface PublicConfig {
  hostUid: string;
  sharedNotebooks: string[];
}

let cached: PublicConfig | null = null;

export function getCachedPublicConfig(): PublicConfig | null {
  return cached;
}

/**
 * Guest path: find any publicConfig document across all users via collectionGroup query.
 * Returns null when no host has published a config yet.
 */
export async function discoverPublicConfigForGuest(): Promise<PublicConfig | null> {
  const db = getFirebaseFirestore();
  const q = query(collectionGroup(db, 'publicConfig'), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  // d.ref              → users/{uid}/publicConfig/main  (DocumentReference)
  // d.ref.parent       → users/{uid}/publicConfig       (CollectionReference)
  // d.ref.parent.parent → users/{uid}                   (DocumentReference)
  // .id                → uid
  const hostUid = d.ref.parent.parent!.id;
  const data = d.data() as { sharedNotebooks?: string[] };
  cached = { hostUid, sharedNotebooks: data.sharedNotebooks ?? [] };
  return cached;
}

/**
 * Host path (read): fetch publicConfig for the signed-in host.
 */
export async function readPublicConfigForHost(
  hostUid: string
): Promise<{ sharedNotebooks: string[] }> {
  const db = getFirebaseFirestore();
  const ref = doc(db, 'users', hostUid, 'publicConfig', 'main');
  const snap = await getDoc(ref);
  const data = snap.exists() ? (snap.data() as { sharedNotebooks?: string[] }) : {};
  const out = { sharedNotebooks: data.sharedNotebooks ?? [] };
  cached = { hostUid, sharedNotebooks: out.sharedNotebooks };
  return out;
}

/**
 * Host path (write): publish or update publicConfig with merge semantics.
 */
export async function writePublicConfigAsHost(
  hostUid: string,
  cfg: { sharedNotebooks: string[] }
): Promise<void> {
  const db = getFirebaseFirestore();
  const ref = doc(db, 'users', hostUid, 'publicConfig', 'main');
  await setDoc(ref, { sharedNotebooks: cfg.sharedNotebooks }, { merge: true });
  cached = { hostUid, sharedNotebooks: cfg.sharedNotebooks };
}

/** Test-only: reset in-memory cache between test runs. */
export function _resetCache(): void {
  cached = null;
}
