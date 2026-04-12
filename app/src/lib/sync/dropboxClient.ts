/**
 * Dropbox client wrapper.
 * Uses OAuth PKCE flow (no client secret needed for browser-only SPA).
 *
 * Tokens are stored in localStorage (acceptable for single personal user).
 * The Dropbox SDK handles token refresh automatically when a refresh_token is present.
 */

import { Dropbox, DropboxAuth } from 'dropbox';
import { PUBLIC_DROPBOX_APP_KEY } from '$env/static/public';

const STORAGE_KEY_ACCESS_TOKEN = 'tomboy-dropbox-access-token';
const STORAGE_KEY_REFRESH_TOKEN = 'tomboy-dropbox-refresh-token';
const STORAGE_KEY_EXPIRES_AT = 'tomboy-dropbox-expires-at';
const STORAGE_KEY_NOTES_PATH = 'tomboy-dropbox-notes-path';

/** Get the configured Dropbox folder path (e.g. '/Apps/Tomboy' or '') */
export function getNotesPath(): string {
	return localStorage.getItem(STORAGE_KEY_NOTES_PATH) ?? '';
}

/** Set the Dropbox folder path */
export function setNotesPath(path: string): void {
	// Normalize: ensure leading slash, strip trailing slash
	const normalized = path.trim().replace(/\/+$/, '');
	const withSlash = normalized && !normalized.startsWith('/') ? '/' + normalized : normalized;
	localStorage.setItem(STORAGE_KEY_NOTES_PATH, withSlash);
}

function getAppKey(): string {
	return PUBLIC_DROPBOX_APP_KEY ?? '';
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
		undefined,
		undefined,
		true // usePKCE
	);

	// Store the code verifier for the callback
	const codeVerifier = auth.getCodeVerifier();
	localStorage.setItem('tomboy-dropbox-code-verifier', codeVerifier);

	window.location.href = authUrl as string;
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
		const xml = await downloadText(dbx, path);
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
export async function downloadNoteAtRevision(guid: string, rev: number): Promise<string> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const path = noteRevisionPath(getNotesPath(), guid, rev);
	return downloadText(dbx, path);
}

/**
 * Upload notes as a new revision and atomically commit the root manifest.
 *
 * Steps:
 *   1. Upload each note file to /{parent}/{newRev}/{guid}.note
 *   2. Write /{parent}/{newRev}/manifest.xml  (per-revision snapshot)
 *   3. Overwrite /manifest.xml  (root — single source of truth)
 */
export async function commitRevision(
	newRev: number,
	uploadNotes: Array<{ guid: string; content: string }>,
	deletedGuids: string[],
	prevManifest: TomboyServerManifest
): Promise<void> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();

	// 1. Upload note files
	for (const { guid, content } of uploadNotes) {
		await uploadText(dbx, noteRevisionPath(notesPath, guid, newRev), content);
	}

	// 2. Build updated note map
	const noteMap = new Map<string, number>();
	for (const n of prevManifest.notes) noteMap.set(n.guid, n.rev);
	for (const { guid } of uploadNotes) noteMap.set(guid, newRev);
	for (const guid of deletedGuids) noteMap.delete(guid);

	const manifestXml = buildTomboyManifest(newRev, prevManifest.serverId, noteMap);

	// 3. Write revision manifest
	await uploadText(dbx, revisionManifestPath(notesPath, newRev), manifestXml);

	// 4. Overwrite root manifest (atomic from Dropbox's perspective)
	await uploadText(dbx, rootManifestPath(notesPath), manifestXml);
}

/**
 * Initialize a fresh server manifest when no manifest.xml exists yet.
 * Uploads all provided notes at revision 1.
 */
export async function initServerManifest(
	uploadNotes: Array<{ guid: string; content: string }>
): Promise<TomboyServerManifest> {
	const dbx = getClient();
	if (!dbx) throw new Error('Not authenticated');

	const notesPath = getNotesPath();
	const serverId = crypto.randomUUID();
	const rev = 1;

	for (const { guid, content } of uploadNotes) {
		await uploadText(dbx, noteRevisionPath(notesPath, guid, rev), content);
	}

	const noteMap = new Map<string, number>();
	for (const { guid } of uploadNotes) noteMap.set(guid, rev);

	const manifestXml = buildTomboyManifest(rev, serverId, noteMap);
	await uploadText(dbx, revisionManifestPath(notesPath, rev), manifestXml);
	await uploadText(dbx, rootManifestPath(notesPath), manifestXml);

	return {
		revision: rev,
		serverId,
		notes: uploadNotes.map(({ guid }) => ({ guid, rev }))
	};
}

