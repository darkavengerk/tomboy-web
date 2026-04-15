/**
 * Upload-safety audit for commitRevision / initServerManifest.
 *
 * Verifies that the web client obeys Tomboy desktop's FileSystem sync invariants
 * (ref/Tomboy/Synchronization/FileSystemSyncServer.cs :: CommitSyncTransaction):
 *
 *   (I1) Only "changed" notes are uploaded. Unchanged notes at older revision
 *        paths are never touched or re-uploaded.
 *   (I2) The root manifest carries unchanged notes forward with their ORIGINAL
 *        revision number — never bumped to newRev just because sync ran.
 *   (I3) Updated notes in the manifest point at newRev.
 *   (I4) Deleted notes are dropped from the manifest.
 *   (I5) Note files land at /{floor(rev/100)}/{rev}/{guid}.note (Tomboy layout).
 *   (I6) A revision-scoped manifest is written *before* the root manifest, so a
 *        crash between steps leaves the old root intact (i.e. originals survive).
 *   (I7) The root manifest equals the revision-scoped manifest byte-for-byte.
 *   (I8) commitRevision never issues writes to any path other than the new
 *        revision dir + root manifest — i.e. the commit never overwrites files
 *        belonging to earlier revisions.
 *   (I9) Manifest revision attribute = newRev; server-id preserved from prev.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('$env/static/public', () => ({
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
}));

const uploadCalls: Array<{ path: string; contents: string; mode: unknown }> = [];

// Per-test hooks — reset in beforeEach
let uploadDelayMs: (path: string) => number = () => 0;
let uploadRejector: (path: string) => Error | null = () => null;
let inFlight = 0;
let peakInFlight = 0;

const filesUploadMock = vi.fn(async (arg: { path: string; contents: string; mode: unknown }) => {
	inFlight++;
	if (inFlight > peakInFlight) peakInFlight = inFlight;
	try {
		const delay = uploadDelayMs(arg.path);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		const err = uploadRejector(arg.path);
		if (err) throw err;
		uploadCalls.push({ path: arg.path, contents: String(arg.contents), mode: arg.mode });
		return { result: {} };
	} finally {
		inFlight--;
	}
});

vi.mock('dropbox', () => {
	class DropboxAuth {
		setAccessToken() {}
		setRefreshToken() {}
	}
	class Dropbox {
		filesUpload = filesUploadMock;
	}
	return { Dropbox, DropboxAuth };
});

import {
	commitRevision,
	initServerManifest,
	setNotesPath,
	type TomboyServerManifest
} from '$lib/sync/dropboxClient.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authenticate() {
	localStorage.setItem('tomboy-dropbox-access-token', 'fake-token');
	localStorage.setItem('tomboy-dropbox-refresh-token', 'fake-refresh');
}

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
		notes: notes.sort((a, b) => a.guid.localeCompare(b.guid))
	};
}

function findUpload(path: string) {
	return uploadCalls.find((c) => c.path === path);
}

function findUploadIndex(path: string) {
	return uploadCalls.findIndex((c) => c.path === path);
}

beforeEach(() => {
	uploadCalls.length = 0;
	filesUploadMock.mockClear();
	uploadDelayMs = () => 0;
	uploadRejector = () => null;
	inFlight = 0;
	peakInFlight = 0;
	localStorage.clear();
	authenticate();
	setNotesPath(''); // root
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('commitRevision — Tomboy upload invariants', () => {
	const prev: TomboyServerManifest = {
		revision: 5,
		serverId: 'SERVER-UUID-ABC',
		notes: [
			{ guid: 'keep-a', rev: 2 },
			{ guid: 'keep-b', rev: 4 },
			{ guid: 'update-c', rev: 3 },
			{ guid: 'delete-d', rev: 1 }
		]
	};

	it('I1+I8: writes ONLY to new revision dir + root manifest (never touches old revisions)', async () => {
		await commitRevision(
			6,
			[{ guid: 'update-c', content: '<note>new c</note>' }],
			['delete-d'],
			prev
		);

		// Expected writes: /0/6/update-c.note, /0/6/manifest.xml, /manifest.xml
		expect(uploadCalls).toHaveLength(3);

		const allowed = new Set(['/0/6/update-c.note', '/0/6/manifest.xml', '/manifest.xml']);
		for (const call of uploadCalls) {
			expect(allowed.has(call.path), `Unexpected write to ${call.path}`).toBe(true);
		}

		// Critical: no write to /0/2/keep-a.note, /0/4/keep-b.note, /0/3/update-c.note,
		// or any path under previous revision directories.
		for (const call of uploadCalls) {
			expect(call.path).not.toMatch(/\/(0\/[0-5])\//);
		}
	});

	it('I5: uploaded note file goes to /{floor(rev/100)}/{rev}/{guid}.note', async () => {
		await commitRevision(
			312,
			[{ guid: 'abc-def', content: '<note>x</note>' }],
			[],
			{ ...prev, revision: 311 }
		);
		expect(findUpload('/3/312/abc-def.note')).toBeDefined();
		expect(findUpload('/3/312/abc-def.note')!.contents).toBe('<note>x</note>');
		expect(findUpload('/3/312/manifest.xml')).toBeDefined();
		expect(findUpload('/manifest.xml')).toBeDefined();
	});

	it('I2+I3+I4: manifest preserves unchanged notes at original rev, updates changed notes, drops deleted', async () => {
		await commitRevision(
			6,
			[{ guid: 'update-c', content: '<note>c</note>' }],
			['delete-d'],
			prev
		);

		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		expect(parsed.revision).toBe(6);
		expect(parsed.serverId).toBe('SERVER-UUID-ABC');
		expect(parsed.notes).toEqual([
			{ guid: 'keep-a', rev: 2 },       // I2: unchanged, rev preserved
			{ guid: 'keep-b', rev: 4 },       // I2: unchanged, rev preserved
			{ guid: 'update-c', rev: 6 }      // I3: updated → newRev
			// I4: delete-d absent
		]);
	});

	it('I6: revision manifest is written BEFORE root manifest (crash-safety of originals)', async () => {
		await commitRevision(
			6,
			[{ guid: 'update-c', content: '<note>c</note>' }],
			[],
			prev
		);
		const revIdx = findUploadIndex('/0/6/manifest.xml');
		const rootIdx = findUploadIndex('/manifest.xml');
		expect(revIdx).toBeGreaterThanOrEqual(0);
		expect(rootIdx).toBeGreaterThanOrEqual(0);
		expect(revIdx).toBeLessThan(rootIdx);
	});

	it('I6: note files are uploaded BEFORE any manifest (so a half-written commit points at notes that exist)', async () => {
		await commitRevision(
			6,
			[
				{ guid: 'n1', content: '<note>1</note>' },
				{ guid: 'n2', content: '<note>2</note>' }
			],
			[],
			prev
		);
		const noteIdx1 = findUploadIndex('/0/6/n1.note');
		const noteIdx2 = findUploadIndex('/0/6/n2.note');
		const revManifestIdx = findUploadIndex('/0/6/manifest.xml');
		const rootManifestIdx = findUploadIndex('/manifest.xml');

		expect(noteIdx1).toBeLessThan(revManifestIdx);
		expect(noteIdx2).toBeLessThan(revManifestIdx);
		expect(revManifestIdx).toBeLessThan(rootManifestIdx);
	});

	it('I7: root manifest content === revision manifest content (byte-for-byte)', async () => {
		await commitRevision(
			6,
			[{ guid: 'update-c', content: '<note>c</note>' }],
			['delete-d'],
			prev
		);
		const revXml = findUpload('/0/6/manifest.xml')!.contents;
		const rootXml = findUpload('/manifest.xml')!.contents;
		expect(rootXml).toBe(revXml);
	});

	it('I9: manifest revision = newRev, server-id preserved from previous manifest', async () => {
		await commitRevision(
			42,
			[{ guid: 'x', content: '<note/>' }],
			[],
			{ ...prev, revision: 41, serverId: 'KEEP-ME-SERVER-ID' }
		);
		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		expect(parsed.revision).toBe(42);
		expect(parsed.serverId).toBe('KEEP-ME-SERVER-ID');
	});

	it('uses overwrite mode (Dropbox atomic per-file write)', async () => {
		await commitRevision(6, [{ guid: 'c', content: '<note/>' }], [], prev);
		for (const call of uploadCalls) {
			expect(call.mode).toEqual({ '.tag': 'overwrite' });
		}
	});

	it('no-op safety: with empty uploads and empty deletes, still writes a valid manifest carrying forward ALL previous notes', async () => {
		await commitRevision(6, [], [], prev);
		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		expect(parsed.revision).toBe(6);
		expect(parsed.notes).toEqual([
			{ guid: 'delete-d', rev: 1 },
			{ guid: 'keep-a', rev: 2 },
			{ guid: 'keep-b', rev: 4 },
			{ guid: 'update-c', rev: 3 }
		]);
		// No note files uploaded.
		const noteUploads = uploadCalls.filter((c) => c.path.endsWith('.note'));
		expect(noteUploads).toHaveLength(0);
	});

	it('delete-only commit: does NOT upload the deleted note nor touch its old revision file', async () => {
		await commitRevision(6, [], ['delete-d'], prev);

		// No note uploads at all — deletion is manifest-only.
		expect(uploadCalls.filter((c) => c.path.endsWith('.note'))).toHaveLength(0);

		// Old path /0/1/delete-d.note is never written.
		expect(findUpload('/0/1/delete-d.note')).toBeUndefined();

		// Manifest drops delete-d.
		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		expect(parsed.notes.map((n) => n.guid)).not.toContain('delete-d');
	});

	it('notesPath prefix is applied to every write path', async () => {
		setNotesPath('/Apps/Tomboy');
		await commitRevision(6, [{ guid: 'c', content: '<note/>' }], [], prev);

		expect(findUpload('/Apps/Tomboy/0/6/c.note')).toBeDefined();
		expect(findUpload('/Apps/Tomboy/0/6/manifest.xml')).toBeDefined();
		expect(findUpload('/Apps/Tomboy/manifest.xml')).toBeDefined();
		// No stray writes to the root path.
		for (const call of uploadCalls) {
			expect(call.path.startsWith('/Apps/Tomboy/')).toBe(true);
		}
	});

	it('simultaneous update + delete + carry-forward produce a coherent manifest', async () => {
		await commitRevision(
			6,
			[
				{ guid: 'update-c', content: '<note>c-new</note>' },
				{ guid: 'new-e', content: '<note>brand new</note>' }
			],
			['delete-d'],
			prev
		);

		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		expect(parsed.notes).toEqual([
			{ guid: 'keep-a', rev: 2 },
			{ guid: 'keep-b', rev: 4 },
			{ guid: 'new-e', rev: 6 },
			{ guid: 'update-c', rev: 6 }
		]);

		// Only the two changed notes are uploaded — keep-a, keep-b are not touched.
		const noteUploads = uploadCalls.filter((c) => c.path.endsWith('.note')).map((c) => c.path);
		expect(noteUploads.sort()).toEqual(['/0/6/new-e.note', '/0/6/update-c.note']);
	});

	it('carry-forward rev is independent of newRev (Tomboy: @rev is content age, not commit age)', async () => {
		// keep-a was written at rev=2. After 100 commits, it is STILL rev=2 in the manifest.
		const farFuture: TomboyServerManifest = {
			revision: 200,
			serverId: 'SID',
			notes: [{ guid: 'ancient', rev: 2 }]
		};
		await commitRevision(201, [{ guid: 'fresh', content: '<note/>' }], [], farFuture);

		const parsed = parseManifest(findUpload('/manifest.xml')!.contents);
		const ancient = parsed.notes.find((n) => n.guid === 'ancient')!;
		expect(ancient.rev).toBe(2); // NOT 201 — critical Tomboy invariant
	});
});

describe('commitRevision — parallel upload safety', () => {
	const prev: TomboyServerManifest = {
		revision: 10,
		serverId: 'SID-PARALLEL',
		notes: []
	};

	function makeUploads(n: number) {
		return Array.from({ length: n }, (_, i) => ({
			guid: `g-${String(i).padStart(3, '0')}`,
			content: `<note>${i}</note>`
		}));
	}

	it('layered ordering: ALL note uploads complete before either manifest (even under parallel)', async () => {
		uploadDelayMs = (p) => (p.endsWith('.note') ? 10 : 0);
		const uploads = makeUploads(20);
		await commitRevision(11, uploads, [], prev, { concurrency: 8 });

		const noteIdxs = uploadCalls
			.map((c, i) => ({ p: c.path, i }))
			.filter((x) => x.p.endsWith('.note'))
			.map((x) => x.i);
		const revIdx = uploadCalls.findIndex((c) => c.path === '/0/11/manifest.xml');
		const rootIdx = uploadCalls.findIndex((c) => c.path === '/manifest.xml');

		expect(noteIdxs).toHaveLength(20);
		expect(revIdx).toBeGreaterThan(-1);
		expect(rootIdx).toBeGreaterThan(-1);
		expect(Math.max(...noteIdxs)).toBeLessThan(revIdx);
		expect(revIdx).toBeLessThan(rootIdx);
	});

	it('actually runs in parallel: peak in-flight > 1 when concurrency > 1', async () => {
		uploadDelayMs = (p) => (p.endsWith('.note') ? 20 : 0);
		const uploads = makeUploads(16);
		await commitRevision(11, uploads, [], prev, { concurrency: 8 });
		expect(peakInFlight).toBeGreaterThan(1);
	});

	it('respects concurrency limit: peak in-flight <= limit', async () => {
		uploadDelayMs = (p) => (p.endsWith('.note') ? 10 : 0);
		const uploads = makeUploads(50);
		await commitRevision(11, uploads, [], prev, { concurrency: 8 });
		expect(peakInFlight).toBeLessThanOrEqual(8);
	});

	it('CRITICAL: if any note upload fails, NEITHER manifest is written (server stays consistent)', async () => {
		uploadRejector = (p) => (p === '/0/11/g-007.note' ? new Error('network') : null);
		const uploads = makeUploads(20);
		await expect(
			commitRevision(11, uploads, [], prev, { concurrency: 8 })
		).rejects.toThrow();

		// Server-state invariant: the root manifest MUST NOT have been overwritten.
		expect(findUpload('/manifest.xml')).toBeUndefined();
		// And the revision-scoped manifest should not appear either — its presence
		// would falsely advertise notes that aren't actually there.
		expect(findUpload('/0/11/manifest.xml')).toBeUndefined();
	});

	it('idempotent retry after partial failure: re-running the same commit succeeds', async () => {
		const uploads = makeUploads(10);

		// First attempt — inject a failure
		uploadRejector = (p) => (p === '/0/11/g-003.note' ? new Error('transient') : null);
		await expect(
			commitRevision(11, uploads, [], prev, { concurrency: 4 })
		).rejects.toThrow();

		// Clear the failure injection and retry with identical args
		uploadRejector = () => null;
		uploadCalls.length = 0;
		await commitRevision(11, uploads, [], prev, { concurrency: 4 });

		// Full success: every note + both manifests present
		for (let i = 0; i < 10; i++) {
			expect(findUpload(`/0/11/g-${String(i).padStart(3, '0')}.note`)).toBeDefined();
		}
		expect(findUpload('/0/11/manifest.xml')).toBeDefined();
		expect(findUpload('/manifest.xml')).toBeDefined();
	});

	it('concurrency=1 (sequential) remains valid and keeps legacy ordering', async () => {
		uploadDelayMs = (p) => (p.endsWith('.note') ? 5 : 0);
		const uploads = makeUploads(5);
		await commitRevision(11, uploads, [], prev, { concurrency: 1 });
		expect(peakInFlight).toBe(1);
		// Notes in registration order
		const noteUploads = uploadCalls.filter((c) => c.path.endsWith('.note'));
		expect(noteUploads.map((c) => c.path)).toEqual([
			'/0/11/g-000.note',
			'/0/11/g-001.note',
			'/0/11/g-002.note',
			'/0/11/g-003.note',
			'/0/11/g-004.note'
		]);
	});
});

describe('initServerManifest — fresh-server bootstrap', () => {
	it('uploads notes to /0/1/ and writes both manifests; old paths are never touched', async () => {
		const manifest = await initServerManifest([
			{ guid: 'n1', content: '<note>1</note>' },
			{ guid: 'n2', content: '<note>2</note>' }
		]);

		expect(manifest.revision).toBe(1);
		expect(manifest.serverId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(manifest.notes.sort((a, b) => a.guid.localeCompare(b.guid))).toEqual([
			{ guid: 'n1', rev: 1 },
			{ guid: 'n2', rev: 1 }
		]);

		expect(findUpload('/0/1/n1.note')).toBeDefined();
		expect(findUpload('/0/1/n2.note')).toBeDefined();
		expect(findUpload('/0/1/manifest.xml')).toBeDefined();
		expect(findUpload('/manifest.xml')).toBeDefined();
	});

	it('revision manifest is written before root manifest', async () => {
		await initServerManifest([{ guid: 'n1', content: '<note/>' }]);
		const revIdx = findUploadIndex('/0/1/manifest.xml');
		const rootIdx = findUploadIndex('/manifest.xml');
		expect(revIdx).toBeLessThan(rootIdx);
	});

	it('note files are written before manifests', async () => {
		await initServerManifest([{ guid: 'n1', content: '<note/>' }]);
		const noteIdx = findUploadIndex('/0/1/n1.note');
		const revIdx = findUploadIndex('/0/1/manifest.xml');
		expect(noteIdx).toBeLessThan(revIdx);
	});

	it('root manifest === revision manifest', async () => {
		await initServerManifest([{ guid: 'n1', content: '<note/>' }]);
		expect(findUpload('/manifest.xml')!.contents).toBe(
			findUpload('/0/1/manifest.xml')!.contents
		);
	});
});
