// BRIDGE_NOTES_FILE creds + Firestore REST 접근. 의존성 0 (node:crypto RS256 + fetch).
// 문서 스키마는 app notePayload.ts / pipeline s4_write 미러 — 10필드 전부 필수.
import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';

export interface NotesCreds {
	uid: string;
	notebook: string; // 가드 + 새 노트 태그. 기본 '개발'
	serviceAccount: { project_id: string; client_email: string; private_key: string };
}

export interface NoteDoc {
	guid: string;
	uri: string;
	title: string;
	xmlContent: string;
	createDate: string;
	changeDate: string;
	metadataChangeDate: string;
	tags: string[];
	deleted: boolean;
	public: boolean;
}

export interface NotesStore {
	findByTitle(creds: NotesCreds, title: string): Promise<NoteDoc | null>;
	listByNotebook(creds: NotesCreds): Promise<NoteDoc[]>;
	write(creds: NotesCreds, doc: NoteDoc): Promise<void>;
}

/** BRIDGE_NOTES_FILE 경로. 호출마다 재평가 — 캐시 없음 (hueCreds 패턴). */
export function readNotesCreds(): NotesCreds | null {
	const p = process.env.BRIDGE_NOTES_FILE;
	if (!p || !p.trim()) return null;
	let raw: string;
	try {
		raw = readFileSync(p, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[term-bridge] notesCreds read failed ${p}:`, err);
		return null;
	}
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		const sa = v.serviceAccount as Record<string, unknown> | undefined;
		if (typeof v.uid !== 'string' || !v.uid) return null;
		if (!sa || typeof sa.project_id !== 'string' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return null;
		if (!sa.project_id || !sa.client_email || !sa.private_key) return null;
		const notebook = typeof v.notebook === 'string' && v.notebook ? v.notebook : '개발';
		return {
			uid: v.uid,
			notebook,
			serviceAccount: { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key }
		};
	} catch {
		return null;
	}
}

// ---- SA JWT → OAuth 액세스 토큰 (만료 60초 전까지 캐시) ----
let tokenCache: { token: string; exp: number; email: string } | null = null;
export function __resetTokenCacheForTest(): void {
	tokenCache = null;
}

function b64url(buf: Buffer | string): string {
	return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getAccessToken(creds: NotesCreds, fetchFn: typeof fetch = fetch): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (tokenCache && tokenCache.email === creds.serviceAccount.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: creds.serviceAccount.client_email,
			scope: 'https://www.googleapis.com/auth/datastore',
			aud: 'https://oauth2.googleapis.com/token',
			iat: now - 10,
			exp: now + 3600
		})
	);
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${claims}`);
	const sig = signer.sign(creds.serviceAccount.private_key);
	const res = await fetchFn('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claims}.${b64url(sig)}`
	});
	if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as { access_token: string; expires_in?: number };
	if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('token exchange returned no access_token');
	tokenCache = { token: data.access_token, exp: now + (data.expires_in ?? 3600), email: creds.serviceAccount.client_email };
	return data.access_token;
}

// ---- Firestore REST 값 매핑 ----
type FsValue =
	| { stringValue: string }
	| { booleanValue: boolean }
	| { arrayValue: { values?: FsValue[] } };

function toFields(doc: NoteDoc): Record<string, FsValue> {
	return {
		guid: { stringValue: doc.guid },
		uri: { stringValue: doc.uri },
		title: { stringValue: doc.title },
		xmlContent: { stringValue: doc.xmlContent },
		createDate: { stringValue: doc.createDate },
		changeDate: { stringValue: doc.changeDate },
		metadataChangeDate: { stringValue: doc.metadataChangeDate },
		tags: { arrayValue: { values: doc.tags.map((t) => ({ stringValue: t })) } },
		deleted: { booleanValue: doc.deleted },
		public: { booleanValue: doc.public }
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFields(fields: Record<string, any>): NoteDoc {
	const s = (k: string) => String(fields[k]?.stringValue ?? '');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tags = (fields.tags?.arrayValue?.values ?? []).map((v: any) => String(v.stringValue ?? ''));
	return {
		guid: s('guid'),
		uri: s('uri'),
		title: s('title'),
		xmlContent: s('xmlContent'),
		createDate: s('createDate'),
		changeDate: s('changeDate'),
		metadataChangeDate: s('metadataChangeDate'),
		tags,
		deleted: fields.deleted?.booleanValue === true,
		public: fields.public?.booleanValue === true
	};
}

function baseUrl(creds: NotesCreds): string {
	return `https://firestore.googleapis.com/v1/projects/${creds.serviceAccount.project_id}/databases/(default)`;
}

export function createFirestoreNotesStore(fetchFn: typeof fetch = fetch): NotesStore {
	async function runQuery(creds: NotesCreds, structuredQuery: unknown): Promise<NoteDoc[]> {
		const token = await getAccessToken(creds, fetchFn);
		const res = await fetchFn(`${baseUrl(creds)}/documents/users/${creds.uid}:runQuery`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify({ structuredQuery })
		});
		if (!res.ok) throw new Error(`firestore query failed: ${res.status} ${await res.text()}`);
		const rows = (await res.json()) as Array<{ document?: { name: string; fields: Record<string, unknown> } }>;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return rows.filter((r) => r.document).map((r) => fromFields(r.document!.fields as Record<string, any>));
	}
	return {
		async findByTitle(creds, title) {
			const docs = await runQuery(creds, {
				from: [{ collectionId: 'notes' }],
				where: { fieldFilter: { field: { fieldPath: 'title' }, op: 'EQUAL', value: { stringValue: title } } },
				limit: 2
			});
			if (docs.length > 1) console.warn(`[term-bridge] duplicate title in Firestore: ${title}`);
			return docs[0] ?? null;
		},
		async listByNotebook(creds) {
			return runQuery(creds, {
				from: [{ collectionId: 'notes' }],
				where: {
					fieldFilter: {
						field: { fieldPath: 'tags' },
						op: 'ARRAY_CONTAINS',
						value: { stringValue: `system:notebook:${creds.notebook}` }
					}
				}
			});
		},
		async write(creds, doc) {
			const token = await getAccessToken(creds, fetchFn);
			const name = `projects/${creds.serviceAccount.project_id}/databases/(default)/documents/users/${creds.uid}/notes/${doc.guid}`;
			const res = await fetchFn(`${baseUrl(creds)}/documents:commit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
				body: JSON.stringify({
					writes: [
						{
							update: { name, fields: toFields(doc) },
							updateTransforms: [{ fieldPath: 'serverUpdatedAt', setToServerValue: 'REQUEST_TIME' }]
						}
					]
				})
			});
			if (!res.ok) throw new Error(`firestore commit failed: ${res.status} ${await res.text()}`);
		}
	};
}

// ---- 공용 헬퍼 ----
/** Tomboy 날짜: yyyy-MM-ddTHH:mm:ss.fffffff±HH:MM (app core/note.ts formatTomboyDate 미러, 로컬 tz). */
export function formatTomboyDate(d = new Date()): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	const frac = pad(d.getMilliseconds(), 3) + '0000';
	const offMin = -d.getTimezoneOffset();
	const sign = offMin >= 0 ? '+' : '-';
	const abs = Math.abs(offMin);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function newGuid(): string {
	return randomUUID();
}
