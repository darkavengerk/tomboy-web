/**
 * Dropbox client wrapper.
 * Uses OAuth PKCE flow (no client secret needed for browser-only SPA).
 *
 * Tokens are stored in localStorage (acceptable for single personal user).
 * The Dropbox SDK handles token refresh automatically when a refresh_token is present.
 */

import { Dropbox, DropboxAuth } from 'dropbox';
import { env } from '$env/dynamic/public';

const STORAGE_KEY_ACCESS_TOKEN = 'tomboy-dropbox-access-token';
const STORAGE_KEY_REFRESH_TOKEN = 'tomboy-dropbox-refresh-token';
const STORAGE_KEY_EXPIRES_AT = 'tomboy-dropbox-expires-at';
const STORAGE_KEY_NOTES_PATH = 'tomboy-dropbox-notes-path';
const STORAGE_KEY_SETTINGS_PATH = 'tomboy-dropbox-settings-path';
const STORAGE_KEY_IMAGES_PATH = 'tomboy-dropbox-images-path';

const DEFAULT_IMAGES_PATH = '/tomboy-image';

function normalizePath(path: string): string {
	const normalized = path.trim().replace(/\/+$/, '');
	return normalized && !normalized.startsWith('/') ? '/' + normalized : normalized;
}

/** Get the configured Dropbox folder path (e.g. '/Apps/Tomboy' or '') */
export function getNotesPath(): string {
	return localStorage.getItem(STORAGE_KEY_NOTES_PATH) ?? '';
}

/** Set the Dropbox folder path */
export function setNotesPath(path: string): void {
	localStorage.setItem(STORAGE_KEY_NOTES_PATH, normalizePath(path));
}

/** Get the configured Dropbox folder path for settings/workspace state. */
export function getSettingsPath(): string {
	return localStorage.getItem(STORAGE_KEY_SETTINGS_PATH) ?? '';
}

/** Set the Dropbox folder path for settings/workspace state. */
export function setSettingsPath(path: string): void {
	localStorage.setItem(STORAGE_KEY_SETTINGS_PATH, normalizePath(path));
}

/**
 * Get the configured Dropbox folder path for uploaded images.
 * Deliberately separated from the notes path so image files don't end up
 * in the revision-manifest tree that `commitRevision` walks.
 * Defaults to `/tomboy-image`.
 */
export function getImagesPath(): string {
	const stored = localStorage.getItem(STORAGE_KEY_IMAGES_PATH);
	if (stored === null || stored === '') return DEFAULT_IMAGES_PATH;
	return stored;
}

/** Set the Dropbox folder path for uploaded images. */
export function setImagesPath(path: string): void {
	localStorage.setItem(STORAGE_KEY_IMAGES_PATH, normalizePath(path));
}

function getAppKey(): string {
	return env.PUBLIC_DROPBOX_APP_KEY ?? '';
}

/** Create a DropboxAuth instance for PKCE auth */
function createAuth(): DropboxAuth {
	return new DropboxAuth({
		clientId: getAppKey()
	});
}

/** Check if we have stored Dropbox credentials */
export function isAuthenticated(): boolean {
	return !!localStorage.getItem(STORAGE_KEY_ACCESS_TOKEN);
}

/** Get stored tokens */
function getStoredTokens() {
	return {
		accessToken: localStorage.getItem(STORAGE_KEY_ACCESS_TOKEN) ?? '',
		refreshToken: localStorage.getItem(STORAGE_KEY_REFRESH_TOKEN) ?? '',
		expiresAt: localStorage.getItem(STORAGE_KEY_EXPIRES_AT) ?? ''
	};
}

/** Store tokens after successful auth */
function storeTokens(accessToken: string, refreshToken: string, expiresIn?: number) {
	localStorage.setItem(STORAGE_KEY_ACCESS_TOKEN, accessToken);
	if (refreshToken) {
		localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, refreshToken);
	}
	if (expiresIn) {
		const expiresAt = String(Date.now() + expiresIn * 1000);
		localStorage.setItem(STORAGE_KEY_EXPIRES_AT, expiresAt);
	}
}

/** Clear all Dropbox tokens (logout) */
export function clearTokens() {
	localStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN);
	localStorage.removeItem(STORAGE_KEY_REFRESH_TOKEN);
	localStorage.removeItem(STORAGE_KEY_EXPIRES_AT);
	localStorage.removeItem('tomboy-dropbox-code-verifier');
}

/**
 * Append `force_reapprove=true` to a Dropbox OAuth authorize URL (idempotent).
 *
 * Without this param, Dropbox silently re-grants previously-approved
 * scopes when a user "reconnects" — if the app has since added new
 * scopes, no consent screen shows and the new token lacks them. That
 * makes scope migrations appear to "just work" from the UI perspective
 * while API calls that need the new scope silently 401. Forcing the
 * consent screen surfaces the migration to the user.
 */
export function forceReapproveUrl(authUrl: string): string {
	if (/[?&]force_reapprove=true(?:&|$)/.test(authUrl)) return authUrl;
	const separator = authUrl.includes('?') ? '&' : '?';
	return authUrl + separator + 'force_reapprove=true';
}

/**
 * Start the OAuth PKCE flow.
 * Redirects the browser to Dropbox authorization page.
 */
export async function startAuth(redirectUri: string): Promise<void> {
	const auth = createAuth();
	const authUrl = await auth.getAuthenticationUrl(
		redirectUri,
		undefined, // state — not needed for personal use
		'code',
		'offline', // token_access_type — get a refresh_token
		[
			'files.content.read',
			'files.content.write',
			'files.metadata.read',
			'files.metadata.write',
			// Image upload needs to create a public shared link and,
			// in the rare case a link already exists, list the existing one.
			'sharing.write',
			'sharing.read'
		],
		undefined,
		true // usePKCE
	);

	// Store the code verifier for the callback
	const codeVerifier = auth.getCodeVerifier();
	localStorage.setItem('tomboy-dropbox-code-verifier', codeVerifier);

	window.location.href = forceReapproveUrl(authUrl as string);
}

/**
 * Complete the OAuth PKCE flow after redirect.
 * Call this with the authorization code from the URL query params.
 */
export async function completeAuth(code: string, redirectUri: string): Promise<boolean> {
	const codeVerifier = localStorage.getItem('tomboy-dropbox-code-verifier');
	if (!codeVerifier) {
		console.error('No code verifier found');
		return false;
	}

	const auth = createAuth();
	auth.setCodeVerifier(codeVerifier);

	try {
		const response = await auth.getAccessTokenFromCode(redirectUri, code);
		const result = response.result as Record<string, unknown>;
		const accessToken = result.access_token as string;
		const refreshToken = result.refresh_token as string;
		const expiresIn = result.expires_in as number | undefined;

		storeTokens(accessToken, refreshToken, expiresIn);
		localStorage.removeItem('tomboy-dropbox-code-verifier');

		return true;
	} catch (err) {
		console.error('Dropbox auth failed:', err);
		return false;
	}
}

/**
 * Get an authenticated Dropbox client instance.
 * Returns null if not authenticated.
 */
export function getClient(): Dropbox | null {
	const { accessToken, refreshToken } = getStoredTokens();
	if (!accessToken) return null;

	const auth = createAuth();
	auth.setAccessToken(accessToken);
	if (refreshToken) {
		auth.setRefreshToken(refreshToken);
	}

	return new Dropbox({ auth });
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function rootManifestPath(notesPath: string): string {
	return notesPath ? `${notesPath}/manifest.xml` : '/manifest.xml';
}

function noteRevisionPath(notesPath: string, guid: string, rev: number): string {
	const parent = Math.floor(rev / 100);
	return notesPath
		? `${notesPath}/${parent}/${rev}/${guid}.note`
		: `/${parent}/${rev}/${guid}.note`;
}

function revisionManifestPath(notesPath: string, rev: number): string {
	const parent = Math.floor(rev / 100);
	return notesPath
		? `${notesPath}/${parent}/${rev}/manifest.xml`
		: `/${parent}/${rev}/manifest.xml`;
}

async function downloadText(dbx: Dropbox, path: string): Promise<string> {
	const response = await dbx.filesDownload({ path });
	const result = response.result as unknown as Record<string, unknown>;
	const blob = result.fileBlob as Blob;
	return blob.text();
}

async function uploadText(dbx: Dropbox, path: string, content: string): Promise<void> {
	await dbx.filesUpload({
		path,
		contents: content,
		mode: { '.tag': 'overwrite' },
		mute: true
	});
}

// ─── Rate-limit retry ────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

function extractRetryAfterMs(err: unknown): number | null {
	const e = err as {
		status?: number;
		error?: { retry_after?: number };
		headers?: { get?: (k: string) => string | null };
	};
	if (e.status !== 429) return null;
	if (typeof e.error?.retry_after === 'number') return e.error.retry_after * 1000;
	const h = e.headers?.get?.('retry-after');
	if (h) {
		const s = parseInt(h, 10);
		if (!isNaN(s)) return s * 1000;
	}
	return 0; // 429 but no explicit wait
}

export type RetryCallback = (attempt: number, waitMs: number) => void;

async function withRetry<T>(fn: () => Promise<T>, onRetry?: RetryCallback): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const retryMs = extractRetryAfterMs(err);
			if (retryMs === null || attempt >= MAX_RETRIES) throw err;
			const waitMs = retryMs > 0 ? retryMs : Math.min(1000 * 2 ** attempt, 30_000);
			onRetry?.(attempt + 1, waitMs);
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}
}

// ─── Tomboy sync protocol ─────────────────────────────────────────────────────

export interface TomboyServerManifest {
	revision: number;
	serverId: string;
	/** All notes tracked on server: guid → latest revision number */
	notes: Array<{ guid: string; rev: number }>;
}

function parseTomboyManifest(xml: string): TomboyServerManifest {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const root = doc.documentElement;

	const revision = parseInt(root.getAttribute('revision') ?? '0', 10);
	const serverId = root.getAttribute('server-id') ?? '';

	const notes: Array<{ guid: string; rev: number }> = [];
	const noteEls = root.getElementsByTagName('note');
	for (let i = 0; i < noteEls.length; i++) {
		const el = noteEls[i];
		const id = el.getAttribute('id');
		const rev = parseInt(el.getAttribute('rev') ?? '0', 10);
		if (id) notes.push({ guid: id, rev });
	}

	return { revision, serverId, notes };
}

function buildTomboyManifest(rev: number, serverId: string, notes: Map<string, number>): string {
	const lines = [
		`<?xml version="1.0" encoding="utf-8"?>`,
		`<sync revision="${rev}" server-id="${serverId}">`
	];
	for (const [guid, noteRev] of notes) {
		lines.push(`  <note id="${guid}" rev="${noteRev}" />`);
	}
	lines.push(`</sync>`);
	return lines.join('\n');
}

/**
 * Download and parse the root manifest.xml from the configured notes path.
 * Returns null if the manifest doesn't exist yet (fresh server).
 */
export async function downloadServerManifest(): Promise<TomboyServerManifest | null> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const path = rootManifestPath(getNotesPath());
	try {
		const xml = await withRetry(() => downloadText(dbx, path));
		return parseTomboyManifest(xml);
	} catch (err: unknown) {
		const error = err as { status?: number };
		if (error.status === 409) return null; // path_not_found
		throw err;
	}
}

/**
 * Download a note file at a specific server revision.
 * Path: {notesPath}/{rev/100}/{rev}/{guid}.note
 */
export async function downloadNoteAtRevision(
	guid: string,
	rev: number,
	onRetry?: RetryCallback
): Promise<string> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const path = noteRevisionPath(getNotesPath(), guid, rev);
	return withRetry(() => downloadText(dbx, path), onRetry);
}

/**
 * Upload notes as a new revision and atomically commit the root manifest.
 *
 * Steps:
 *   1. Upload each note file to /{parent}/{newRev}/{guid}.note
 *   2. Write /{parent}/{newRev}/manifest.xml  (per-revision snapshot)
 *   3. Overwrite /manifest.xml  (root — single source of truth)
 */
export interface CommitCallbacks {
	onUploadStart?: (guid: string) => void;
	onUploadDone?: (guid: string) => void;
	onUploadRetry?: (guid: string, attempt: number, waitMs: number) => void;
	onUploadError?: (guid: string, error: unknown) => void;
}

export async function commitRevision(
	newRev: number,
	uploadNotes: Array<{ guid: string; content: string }>,
	deletedGuids: string[],
	prevManifest: TomboyServerManifest,
	callbacks?: CommitCallbacks
): Promise<void> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();

	// 1. Upload note files sequentially with retry.
	//    If any fails after retries, we skip manifest writes — the server's
	//    root manifest is left untouched, so a partial upload is invisible.
	for (const { guid, content } of uploadNotes) {
		callbacks?.onUploadStart?.(guid);
		try {
			await withRetry(
				() => uploadText(dbx, noteRevisionPath(notesPath, guid, newRev), content),
				(attempt, waitMs) => callbacks?.onUploadRetry?.(guid, attempt, waitMs)
			);
			callbacks?.onUploadDone?.(guid);
		} catch (err) {
			callbacks?.onUploadError?.(guid, err);
			throw err;
		}
	}

	// 2. Build updated note map
	const noteMap = new Map<string, number>();
	for (const n of prevManifest.notes) noteMap.set(n.guid, n.rev);
	for (const { guid } of uploadNotes) noteMap.set(guid, newRev);
	for (const guid of deletedGuids) noteMap.delete(guid);

	const manifestXml = buildTomboyManifest(newRev, prevManifest.serverId, noteMap);

	// 3. Write revision manifest (with retry)
	await withRetry(() => uploadText(dbx, revisionManifestPath(notesPath, newRev), manifestXml));

	// 4. Overwrite root manifest (with retry)
	await withRetry(() => uploadText(dbx, rootManifestPath(notesPath), manifestXml));
}

/**
 * Initialize a fresh server manifest when no manifest.xml exists yet.
 * Uploads all provided notes at revision 1.
 */
export async function initServerManifest(
	uploadNotes: Array<{ guid: string; content: string }>,
	callbacks?: CommitCallbacks
): Promise<TomboyServerManifest> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();
	const serverId = crypto.randomUUID();
	const rev = 1;

	for (const { guid, content } of uploadNotes) {
		callbacks?.onUploadStart?.(guid);
		try {
			await withRetry(
				() => uploadText(dbx, noteRevisionPath(notesPath, guid, rev), content),
				(attempt, waitMs) => callbacks?.onUploadRetry?.(guid, attempt, waitMs)
			);
			callbacks?.onUploadDone?.(guid);
		} catch (err) {
			callbacks?.onUploadError?.(guid, err);
			throw err;
		}
	}

	const noteMap = new Map<string, number>();
	for (const { guid } of uploadNotes) noteMap.set(guid, rev);

	const manifestXml = buildTomboyManifest(rev, serverId, noteMap);
	await withRetry(() => uploadText(dbx, revisionManifestPath(notesPath, rev), manifestXml));
	await withRetry(() => uploadText(dbx, rootManifestPath(notesPath), manifestXml));

	return {
		revision: rev,
		serverId,
		notes: uploadNotes.map(({ guid }) => ({ guid, rev }))
	};
}

// ─── Admin / revision-history operations ─────────────────────────────────────

/**
 * List revision numbers that still exist on the server by walking the
 * {parent}/{rev}/ folder tree. Returned sorted descending (newest first).
 *
 * The server layout is /{rev/100}/{rev}/..., so we list top-level integer
 * folders, then list each one to collect rev numbers.
 */
export async function listRevisions(): Promise<number[]> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();
	const basePath = notesPath || '';

	const parentRes = await dbx.filesListFolder({ path: basePath });
	const parents: string[] = [];
	for (const entry of parentRes.result.entries) {
		if (entry['.tag'] !== 'folder') continue;
		if (/^\d+$/.test(entry.name)) parents.push(entry.name);
	}

	const revs: number[] = [];
	for (const parent of parents) {
		const parentPath = notesPath ? `${notesPath}/${parent}` : `/${parent}`;
		let res = await dbx.filesListFolder({ path: parentPath });
		while (true) {
			for (const entry of res.result.entries) {
				if (entry['.tag'] !== 'folder') continue;
				if (/^\d+$/.test(entry.name)) revs.push(parseInt(entry.name, 10));
			}
			if (!res.result.has_more) break;
			res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
		}
	}

	return revs.sort((a, b) => b - a);
}

/**
 * Download and parse the per-revision manifest at {notesPath}/{rev/100}/{rev}/manifest.xml.
 * Returns null if that manifest doesn't exist.
 */
export async function downloadRevisionManifest(rev: number): Promise<TomboyServerManifest | null> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const path = revisionManifestPath(getNotesPath(), rev);
	try {
		const xml = await withRetry(() => downloadText(dbx, path));
		return parseTomboyManifest(xml);
	} catch (err: unknown) {
		const error = err as { status?: number };
		if (error.status === 409) return null;
		throw err;
	}
}

/**
 * Soft rollback: commit a new revision whose manifest matches the state at
 * targetRev. Files at the target rev still exist (we never delete history),
 * so the new manifest simply points guid → rev using target's rev numbers.
 *
 * This preserves full history (target rev and all later revs remain on disk)
 * while making the current state match target. On next sync, clients will
 * see the new higher revision number and re-download accordingly.
 *
 * Returns the new committed revision number.
 */
export async function softRollbackToRevision(targetRev: number): Promise<number> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();

	const current = await downloadServerManifest();
	if (!current) throw new Error('서버에 매니페스트가 없습니다');

	const target = await downloadRevisionManifest(targetRev);
	if (!target) throw new Error(`rev ${targetRev} 매니페스트를 찾을 수 없습니다`);

	if (targetRev >= current.revision) {
		throw new Error('대상 리비전은 현재 리비전보다 낮아야 합니다');
	}

	const newRev = current.revision + 1;

	const noteMap = new Map<string, number>();
	for (const n of target.notes) noteMap.set(n.guid, n.rev);

	const manifestXml = buildTomboyManifest(newRev, current.serverId, noteMap);
	await uploadText(dbx, revisionManifestPath(notesPath, newRev), manifestXml);
	await uploadText(dbx, rootManifestPath(notesPath), manifestXml);

	return newRev;
}

export interface FolderEntry {
	name: string;
	path: string;
	kind: 'folder' | 'file';
	size?: number;
	modified?: string;
}

/**
 * List a folder on Dropbox. Used by the raw-file browser in admin.
 */
export async function listFolder(path: string): Promise<FolderEntry[]> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const entries: FolderEntry[] = [];
	let res = await dbx.filesListFolder({ path: path || '' });
	while (true) {
		for (const e of res.result.entries) {
			if (e['.tag'] === 'folder') {
				entries.push({ name: e.name, path: e.path_display ?? e.path_lower ?? '', kind: 'folder' });
			} else if (e['.tag'] === 'file') {
				entries.push({
					name: e.name,
					path: e.path_display ?? e.path_lower ?? '',
					kind: 'file',
					size: e.size,
					modified: e.server_modified
				});
			}
		}
		if (!res.result.has_more) break;
		res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
	}

	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});
	return entries;
}

/** Download any file from Dropbox as text. Used by raw-file viewer and backup. */
export async function downloadFileText(path: string): Promise<string> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');
	return downloadText(dbx, path);
}

/** Expose the configured notes-path root for admin UI. */
export function notesRootPath(): string {
	return getNotesPath() || '';
}

/** Expose the root-manifest path for admin UI. */
export function rootManifestFullPath(): string {
	return rootManifestPath(getNotesPath());
}

/** Build the per-revision manifest path for admin UI. */
export function revisionManifestFullPath(rev: number): string {
	return revisionManifestPath(getNotesPath(), rev);
}

/** Build the note-at-revision path for admin UI. */
export function noteAtRevisionFullPath(guid: string, rev: number): string {
	return noteRevisionPath(getNotesPath(), guid, rev);
}

// ─── Settings-profile sync ──────────────────────────────────────────────────

function sanitizeProfileName(name: string): string {
	const trimmed = name.trim().replace(/[\\/:*?"<>|]/g, '_');
	if (!trimmed) throw new Error('프로필 이름이 비어 있습니다');
	return trimmed;
}

function settingsProfilePath(settingsPath: string, profileName: string): string {
	const file = `${sanitizeProfileName(profileName)}.json`;
	return settingsPath ? `${settingsPath}/${file}` : `/${file}`;
}

/** Upload a settings profile as JSON. Overwrites any existing profile of the same name. */
export async function uploadSettingsProfile(
	profileName: string,
	jsonContent: string
): Promise<void> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');
	const path = settingsProfilePath(getSettingsPath(), profileName);
	await uploadText(dbx, path, jsonContent);
}

/** Download a settings profile's JSON. */
export async function downloadSettingsProfile(profileName: string): Promise<string> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');
	const path = settingsProfilePath(getSettingsPath(), profileName);
	return downloadText(dbx, path);
}

/** List profile names (file stems) found in the settings folder. */
export async function listSettingsProfiles(): Promise<string[]> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');
	const base = getSettingsPath() || '';
	try {
		const names: string[] = [];
		let res = await dbx.filesListFolder({ path: base });
		while (true) {
			for (const e of res.result.entries) {
				if (e['.tag'] !== 'file') continue;
				if (!e.name.toLowerCase().endsWith('.json')) continue;
				names.push(e.name.replace(/\.json$/i, ''));
			}
			if (!res.result.has_more) break;
			res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
		}
		names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		return names;
	} catch (err: unknown) {
		const error = err as { status?: number };
		if (error.status === 409) return []; // folder not found
		throw err;
	}
}

