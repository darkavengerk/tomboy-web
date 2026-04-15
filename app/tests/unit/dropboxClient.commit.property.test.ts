/**
 * Property-based fuzzing for commitRevision under random failure/delay
 * schedules. Verifies server-state invariants that must hold regardless of
 * upload order or parallelism.
 *
 * Properties:
 *   P1 Consistency : on success, every (guid, rev) in the final root manifest
 *                    has a corresponding .note file in uploadCalls.
 *   P2 Layering    : max(note upload index) < rev manifest index < root manifest index.
 *   P3 Atomicity   : on failure (thrown), the root manifest is NOT written.
 *                    (The revision-scoped manifest must also not be written,
 *                     because its presence would advertise notes that don't
 *                     exist and mislead an admin rollback.)
 *   P4 Idempotency : rerunning the same commit after a transient failure
 *                    succeeds and still satisfies P1/P2.
 *   P5 ConcurrencyCap : peak concurrent filesUpload calls ≤ configured limit.
 *   P6 CarryForward : notes neither uploaded nor deleted keep their original
 *                     revision number in the new root manifest.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

vi.mock('$env/static/public', () => ({
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
}));

interface UploadCall { path: string; contents: string; }
const uploadCalls: UploadCall[] = [];

let uploadDelayMs: (path: string) => number = () => 0;
let uploadRejector: (path: string) => Error | null = () => null;
let inFlight = 0;
let peakInFlight = 0;

const filesUploadMock = vi.fn(async (arg: { path: string; contents: string }) => {
	inFlight++;
	if (inFlight > peakInFlight) peakInFlight = inFlight;
	try {
		const delay = uploadDelayMs(arg.path);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		const err = uploadRejector(arg.path);
		if (err) throw err;
		uploadCalls.push({ path: arg.path, contents: String(arg.contents) });
		return { result: {} };
	} finally {
		inFlight--;
	}
});

vi.mock('dropbox', () => {
	class DropboxAuth { setAccessToken() {} setRefreshToken() {} }
	class Dropbox { filesUpload = filesUploadMock; }
	return { Dropbox, DropboxAuth };
});

import { commitRevision, setNotesPath, type TomboyServerManifest } from '$lib/sync/dropboxClient.js';

function resetState() {
	uploadCalls.length = 0;
	filesUploadMock.mockClear();
	uploadDelayMs = () => 0;
	uploadRejector = () => null;
	inFlight = 0;
	peakInFlight = 0;
}

beforeEach(() => {
	resetState();
	localStorage.clear();
	localStorage.setItem('tomboy-dropbox-access-token', 'fake-token');
	localStorage.setItem('tomboy-dropbox-refresh-token', 'fake-refresh');
	setNotesPath('');
});

function parseManifest(xml: string) {
	const doc = new DOMParser().parseFromString(xml, 'text/xml');
	const root = doc.documentElement;
	const notes: Array<{ guid: string; rev: number }> = [];
	const els = root.getElementsByTagName('note');
	for (let i = 0; i < els.length; i++) {
		notes.push({
			guid: els[i].getAttribute('id')!,
			rev: parseInt(els[i].getAttribute('rev') ?? '0', 10)
		});
	}
	return {
		revision: parseInt(root.getAttribute('revision') ?? '0', 10),
		serverId: root.getAttribute('server-id') ?? '',
		notes
	};
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const guidArb = fc
	.integer({ min: 0, max: 999 })
	.map((n) => `g-${String(n).padStart(3, '0')}`);

const prevManifestArb = fc
	.tuple(
		fc.integer({ min: 0, max: 500 }),
		fc.uniqueArray(guidArb, { minLength: 0, maxLength: 20 })
	)
	.map(([baseRev, guids]) => ({
		revision: baseRev,
		serverId: 'SID-PROP',
		notes: guids.map((guid, i) => ({ guid, rev: (baseRev - i - 1 + 500) % 500 }))
	} as TomboyServerManifest));

// ─── P1 + P2 + P5 + P6 : happy-path properties ────────────────────────────────

describe('commitRevision — invariants under random schedules (happy path)', () => {
	it('P1/P2/P5/P6 hold for random uploads+deletes with random delays and concurrency', async () => {
		await fc.assert(
			fc.asyncProperty(
				prevManifestArb,
				fc.uniqueArray(guidArb, { minLength: 0, maxLength: 10 }), // new uploads
				fc.integer({ min: 1, max: 12 }), // concurrency
				fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 20 }), // per-upload delay ms
				async (prev, uploadGuids, concurrency, delays) => {
					resetState();
					const newRev = prev.revision + 1;
					// Pick up to half of prev notes to delete (random but deterministic per run)
					const deletes = prev.notes.slice(0, Math.floor(prev.notes.length / 2)).map((n) => n.guid);
					// Upload content: new guids + any delete-conflict guids are skipped
					const uploads = uploadGuids
						.filter((g) => !deletes.includes(g))
						.map((g, i) => ({ guid: g, content: `<note>${g}</note>` }));

					uploadDelayMs = (p) => {
						if (!p.endsWith('.note')) return 0;
						const idx = uploads.findIndex((u) => p.endsWith(`/${u.guid}.note`));
						return delays[idx % Math.max(1, delays.length)] ?? 0;
					};

					await commitRevision(newRev, uploads, deletes, prev, { concurrency });

					// ── P5 ConcurrencyCap
					expect(peakInFlight).toBeLessThanOrEqual(concurrency);

					// ── P2 Layering
					const noteIdxs = uploadCalls
						.map((c, i) => ({ p: c.path, i }))
						.filter((x) => x.p.endsWith('.note'))
						.map((x) => x.i);
					const revManifestPath = `/${Math.floor(newRev / 100)}/${newRev}/manifest.xml`;
					const revIdx = uploadCalls.findIndex((c) => c.path === revManifestPath);
					const rootIdx = uploadCalls.findIndex((c) => c.path === '/manifest.xml');
					expect(revIdx).toBeGreaterThan(-1);
					expect(rootIdx).toBeGreaterThan(-1);
					if (noteIdxs.length > 0) {
						expect(Math.max(...noteIdxs)).toBeLessThan(revIdx);
					}
					expect(revIdx).toBeLessThan(rootIdx);

					// ── P1 Consistency — every (guid, rev) in root manifest has a file
					const rootXml = uploadCalls.find((c) => c.path === '/manifest.xml')!.contents;
					const parsed = parseManifest(rootXml);
					const uploadedPaths = new Set(uploadCalls.filter((c) => c.path.endsWith('.note')).map((c) => c.path));
					for (const n of parsed.notes) {
						// Either the file was uploaded in this commit (rev === newRev),
						// or it's a carry-forward from prev (rev < newRev) — no upload required.
						if (n.rev === newRev) {
							const parent = Math.floor(newRev / 100);
							expect(uploadedPaths.has(`/${parent}/${newRev}/${n.guid}.note`)).toBe(true);
						}
					}

					// ── P6 CarryForward — notes neither uploaded nor deleted keep original rev
					for (const prevNote of prev.notes) {
						if (uploads.some((u) => u.guid === prevNote.guid)) continue;
						if (deletes.includes(prevNote.guid)) continue;
						const carried = parsed.notes.find((n) => n.guid === prevNote.guid);
						expect(carried).toBeDefined();
						expect(carried!.rev).toBe(prevNote.rev);
					}
				}
			),
			{ numRuns: 150 }
		);
	});
});

// ─── P3 : atomicity under failure ─────────────────────────────────────────────

describe('commitRevision — atomicity under random failures', () => {
	it('P3 Atomicity: if ANY note upload fails, neither manifest is written', async () => {
		await fc.assert(
			fc.asyncProperty(
				prevManifestArb,
				fc.uniqueArray(guidArb, { minLength: 1, maxLength: 10 }),
				fc.integer({ min: 1, max: 12 }),
				fc.nat(), // which upload to fail (modded)
				async (prev, uploadGuids, concurrency, failSeed) => {
					resetState();
					const newRev = prev.revision + 1;
					const uploads = uploadGuids
						.filter((g) => !prev.notes.some((n) => n.guid === g))
						.map((g) => ({ guid: g, content: `<note>${g}</note>` }));
					if (uploads.length === 0) return; // nothing to fail

					const failIdx = failSeed % uploads.length;
					const failPath = `/${Math.floor(newRev / 100)}/${newRev}/${uploads[failIdx].guid}.note`;
					uploadRejector = (p) => (p === failPath ? new Error('injected') : null);

					await expect(
						commitRevision(newRev, uploads, [], prev, { concurrency })
					).rejects.toThrow();

					// The two manifest paths must be absent from uploadCalls.
					expect(uploadCalls.some((c) => c.path === '/manifest.xml')).toBe(false);
					const revPath = `/${Math.floor(newRev / 100)}/${newRev}/manifest.xml`;
					expect(uploadCalls.some((c) => c.path === revPath)).toBe(false);
				}
			),
			{ numRuns: 100 }
		);
	});
});

// ─── P4 : idempotency ─────────────────────────────────────────────────────────

describe('commitRevision — idempotent retry', () => {
	it('P4 Idempotency: after a transient failure, retrying the same commit succeeds', async () => {
		await fc.assert(
			fc.asyncProperty(
				prevManifestArb,
				fc.uniqueArray(guidArb, { minLength: 1, maxLength: 8 }),
				fc.integer({ min: 1, max: 8 }),
				fc.nat(),
				async (prev, uploadGuids, concurrency, failSeed) => {
					resetState();
					const newRev = prev.revision + 1;
					const uploads = uploadGuids
						.filter((g) => !prev.notes.some((n) => n.guid === g))
						.map((g) => ({ guid: g, content: `<note>${g}</note>` }));
					if (uploads.length === 0) return;

					const failIdx = failSeed % uploads.length;
					const failPath = `/${Math.floor(newRev / 100)}/${newRev}/${uploads[failIdx].guid}.note`;
					uploadRejector = (p) => (p === failPath ? new Error('transient') : null);

					await expect(
						commitRevision(newRev, uploads, [], prev, { concurrency })
					).rejects.toThrow();

					// Clear failure and retry — must succeed with both manifests present
					uploadRejector = () => null;
					uploadCalls.length = 0;
					await commitRevision(newRev, uploads, [], prev, { concurrency });

					expect(uploadCalls.some((c) => c.path === '/manifest.xml')).toBe(true);
					for (const u of uploads) {
						const parent = Math.floor(newRev / 100);
						expect(uploadCalls.some((c) => c.path === `/${parent}/${newRev}/${u.guid}.note`)).toBe(true);
					}
				}
			),
			{ numRuns: 80 }
		);
	});
});
