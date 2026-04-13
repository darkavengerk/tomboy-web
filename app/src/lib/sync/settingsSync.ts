import {
	uploadSettingsProfile,
	downloadSettingsProfile,
	listSettingsProfiles
} from './dropboxClient.js';
import { getAllSettings, replaceAllSettings } from '$lib/storage/appSettings.js';

const FORMAT = 'tomboy-settings-v1';

interface SerializedRow {
	id: string;
	value: unknown;
}

interface ProfilePayload {
	format: typeof FORMAT;
	savedAt: string;
	rows: SerializedRow[];
}

/**
 * Encode a single appSettings row for JSON. Blob values become a tagged
 * object carrying a base64 copy of the blob; anything not JSON-round-trippable
 * is dropped with a console warning.
 */
async function encodeRow(row: { id: string; value: unknown }): Promise<SerializedRow | null> {
	const value = row.value;
	if (value instanceof Blob) {
		const buf = await value.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
		return {
			id: row.id,
			value: { __blob: true, mime: value.type || 'application/octet-stream', base64: btoa(binary) }
		};
	}
	try {
		JSON.stringify(value);
		return { id: row.id, value };
	} catch {
		console.warn(`[settingsSync] skipping non-serializable setting: ${row.id}`);
		return null;
	}
}

function decodeRow(row: SerializedRow): { id: string; value: unknown } {
	const v = row.value as { __blob?: boolean; mime?: string; base64?: string } | unknown;
	if (v && typeof v === 'object' && (v as { __blob?: boolean }).__blob) {
		const blob = v as { mime?: string; base64?: string };
		const binary = atob(blob.base64 ?? '');
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return { id: row.id, value: new Blob([bytes], { type: blob.mime ?? '' }) };
	}
	return { id: row.id, value: row.value };
}

/** Build a JSON payload of all current appSettings rows and upload it as `profileName`. */
export async function saveSettingsProfile(profileName: string): Promise<void> {
	const rows = await getAllSettings();
	const encoded: SerializedRow[] = [];
	for (const row of rows) {
		const enc = await encodeRow(row);
		if (enc) encoded.push(enc);
	}
	const payload: ProfilePayload = {
		format: FORMAT,
		savedAt: new Date().toISOString(),
		rows: encoded
	};
	await uploadSettingsProfile(profileName, JSON.stringify(payload, null, 2));
}

/**
 * Download `profileName` and replace the entire local appSettings store.
 * Returns the saved-at timestamp from the profile.
 */
export async function restoreSettingsProfile(profileName: string): Promise<string> {
	const json = await downloadSettingsProfile(profileName);
	const payload = JSON.parse(json) as ProfilePayload;
	if (payload.format !== FORMAT) {
		throw new Error(`알 수 없는 프로필 포맷: ${payload.format}`);
	}
	const rows = payload.rows.map(decodeRow);
	await replaceAllSettings(rows);
	return payload.savedAt;
}

export { listSettingsProfiles };
