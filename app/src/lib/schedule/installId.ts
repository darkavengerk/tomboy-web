/**
 * Stable per-installation identifier. Generated once on first request and
 * persisted to `appSettings`. Used as the device-document key under
 * `users/{uid}/devices/{installId}` so re-registering the SW or refreshing
 * the FCM token doesn't create a duplicate device row.
 */
import { getSetting, setSetting } from '$lib/storage/appSettings.js';
import { generateGuid } from '$lib/utils/guid.js';

const KEY = 'schedule.installId';

export async function getOrCreateInstallId(): Promise<string> {
	const existing = await getSetting<string>(KEY);
	if (existing) return existing;
	const id = generateGuid();
	await setSetting(KEY, id);
	return id;
}
