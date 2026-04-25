/**
 * User-facing flow to enable / disable schedule push notifications.
 * Called from the settings page.
 *
 * enableNotifications() does:
 *   1. Browser support check (Notification + ServiceWorker + Push).
 *   2. Notification.requestPermission().
 *   3. Sign in anonymously to Firebase.
 *   4. Get the SW registration and call FCM getToken with the VAPID key.
 *   5. Persist `users/{uid}/devices/{installId}` to Firestore.
 *   6. Locally record `schedule.notificationsEnabled = true` so the flush
 *      pipeline knows to drain pending diffs to Firestore.
 */
import { getToken, onMessage } from 'firebase/messaging';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import {
	ensureSignedIn,
	getFirebaseMessaging,
	getVapidKey
} from './firebase.js';
import { firestoreScheduleClient } from './firestoreScheduleClient.js';
import { getOrCreateInstallId } from './installId.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';

const NOTIF_ENABLED_KEY = 'schedule.notificationsEnabled';
const FCM_TOKEN_KEY = 'schedule.fcmToken';

export type EnableResult =
	| { ok: true; token: string }
	| { ok: false; reason: 'unsupported' | 'permission-denied' | 'token-failed'; error?: unknown };

export async function isNotificationsEnabled(): Promise<boolean> {
	return (await getSetting<boolean>(NOTIF_ENABLED_KEY)) === true;
}

export async function getStoredFcmToken(): Promise<string | undefined> {
	return getSetting<string>(FCM_TOKEN_KEY);
}

export async function enableNotifications(): Promise<EnableResult> {
	if (typeof window === 'undefined') {
		return { ok: false, reason: 'unsupported' };
	}
	if (!('Notification' in window) || !('serviceWorker' in navigator)) {
		return { ok: false, reason: 'unsupported' };
	}

	const messaging = await getFirebaseMessaging();
	if (!messaging) return { ok: false, reason: 'unsupported' };

	const permission = await Notification.requestPermission();
	if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

	try {
		await ensureSignedIn();
		const registration = await navigator.serviceWorker.ready;
		const token = await getToken(messaging, {
			vapidKey: getVapidKey(),
			serviceWorkerRegistration: registration
		});
		if (!token) return { ok: false, reason: 'token-failed' };

		const installId = await getOrCreateInstallId();
		const scheduleNoteGuid = await getScheduleNoteGuid();
		await firestoreScheduleClient.registerDevice({
			installId,
			token,
			platform: navigator.userAgent,
			scheduleNoteGuid
		});

		await setSetting(FCM_TOKEN_KEY, token);
		await setSetting(NOTIF_ENABLED_KEY, true);
		return { ok: true, token };
	} catch (error) {
		return { ok: false, reason: 'token-failed', error };
	}
}

export async function disableNotifications(): Promise<void> {
	await deleteSetting(NOTIF_ENABLED_KEY);
	await deleteSetting(FCM_TOKEN_KEY);
}

/** Subscribe to foreground push messages — caller decides what to render. */
export async function subscribeForegroundMessages(
	handler: (payload: { title?: string; body?: string; data?: Record<string, string> }) => void
): Promise<() => void> {
	const messaging = await getFirebaseMessaging();
	if (!messaging) return () => {};
	const unsub = onMessage(messaging, (payload) => {
		handler({
			title: payload.notification?.title,
			body: payload.notification?.body,
			data: payload.data as Record<string, string> | undefined
		});
	});
	return unsub;
}
