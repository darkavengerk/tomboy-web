/**
 * User-facing flow to enable / disable schedule push notifications.
 * Called from the settings page.
 *
 * iOS PWA quirk — `Notification.requestPermission()` MUST be called before
 * any other `await` after the click event, otherwise WebKit treats the
 * permission prompt as untrusted and silently drops it. So we call it as
 * the very first async step, before touching Firebase at all.
 */
import { getToken, onMessage } from 'firebase/messaging';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import {
	ensureSignedIn,
	getFirebaseApp,
	getFirebaseMessaging,
	getVapidKey
} from './firebase.js';
import { firestoreScheduleClient } from './firestoreScheduleClient.js';
import { getOrCreateInstallId } from './installId.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';

export interface TestPushResult {
	tokenCount: number;
	successCount: number;
	failureCount: number;
	errors: string[];
}

/**
 * Calls the `sendTestPush` Cloud Function — immediate FCM round-trip for
 * every registered device of the current user. Used by the "테스트 푸시"
 * button to verify push delivery independently of the scheduler.
 */
export async function sendTestPush(): Promise<TestPushResult> {
	await ensureSignedIn();
	const functions = getFunctions(getFirebaseApp(), 'asia-northeast3');
	const fn = httpsCallable<unknown, TestPushResult>(functions, 'sendTestPush');
	const { data } = await fn({});
	return data;
}

/** Locally trigger an SW notification — pure SW + iOS rendering test, no
 * FCM/APNs round-trip. Useful to isolate "is the SW able to show
 * notifications at all?" from "is FCM delivering messages?". */
export async function showLocalTestNotification(): Promise<void> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		throw new Error('서비스워커 미지원');
	}
	if (Notification.permission !== 'granted') {
		throw new Error(`알림 권한이 ${Notification.permission} 상태입니다.`);
	}
	const reg = await navigator.serviceWorker.ready;
	await reg.showNotification('로컬 테스트', {
		body: '서비스워커가 직접 띄운 알림입니다. (FCM 우회)',
		icon: '/icons/icon.svg',
		tag: 'local-test'
	});
}

const NOTIF_ENABLED_KEY = 'schedule.notificationsEnabled';
const FCM_TOKEN_KEY = 'schedule.fcmToken';

export type EnableResult =
	| { ok: true; token: string }
	| { ok: false; reason: EnableFailReason; detail?: string };

export type EnableFailReason =
	| 'no-window'
	| 'no-notification-api'
	| 'no-service-worker'
	| 'not-pwa-installed'
	| 'permission-denied'
	| 'permission-default'
	| 'fcm-unsupported'
	| 'sw-registration-failed'
	| 'token-failed'
	| 'firestore-failed';

export async function isNotificationsEnabled(): Promise<boolean> {
	return (await getSetting<boolean>(NOTIF_ENABLED_KEY)) === true;
}

export async function getStoredFcmToken(): Promise<string | undefined> {
	return getSetting<string>(FCM_TOKEN_KEY);
}

/**
 * Returns a diagnostic snapshot for the settings UI / log so the user can
 * see why activation isn't working without needing remote-debugging.
 */
export interface NotificationDiagnostics {
	hasWindow: boolean;
	hasNotificationApi: boolean;
	hasServiceWorker: boolean;
	standalone: boolean;
	permission: NotificationPermission | 'unknown';
	userAgent: string;
}

export function getNotificationDiagnostics(): NotificationDiagnostics {
	if (typeof window === 'undefined') {
		return {
			hasWindow: false,
			hasNotificationApi: false,
			hasServiceWorker: false,
			standalone: false,
			permission: 'unknown',
			userAgent: ''
		};
	}
	const standalone =
		window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
		(navigator as unknown as { standalone?: boolean }).standalone === true;
	return {
		hasWindow: true,
		hasNotificationApi: 'Notification' in window,
		hasServiceWorker: 'serviceWorker' in navigator,
		standalone,
		permission: 'Notification' in window ? Notification.permission : 'unknown',
		userAgent: navigator.userAgent
	};
}

export async function enableNotifications(): Promise<EnableResult> {
	const diag = getNotificationDiagnostics();
	console.info('[schedule] enableNotifications: diagnostics', diag);

	if (!diag.hasWindow) return { ok: false, reason: 'no-window' };
	if (!diag.hasNotificationApi) return { ok: false, reason: 'no-notification-api' };
	if (!diag.hasServiceWorker) return { ok: false, reason: 'no-service-worker' };

	// iOS PWA gates Web Push behind home-screen install. Calling
	// requestPermission outside standalone mode silently fails on iOS Safari.
	const isLikelyIOS = /iPad|iPhone|iPod/.test(diag.userAgent);
	if (isLikelyIOS && !diag.standalone) {
		return { ok: false, reason: 'not-pwa-installed' };
	}

	// CRITICAL: gesture-first. Call requestPermission as the very first
	// async step. Any prior `await` would break iOS Safari's user-activation
	// trust and the prompt would never appear.
	let permission: NotificationPermission;
	try {
		permission = await Notification.requestPermission();
	} catch (err) {
		console.error('[schedule] requestPermission threw', err);
		return { ok: false, reason: 'permission-denied', detail: String(err) };
	}
	console.info('[schedule] permission result:', permission);
	if (permission === 'denied') return { ok: false, reason: 'permission-denied' };
	if (permission !== 'granted') return { ok: false, reason: 'permission-default' };

	let registration: ServiceWorkerRegistration;
	try {
		registration = await navigator.serviceWorker.ready;
	} catch (err) {
		console.error('[schedule] sw not ready', err);
		return { ok: false, reason: 'sw-registration-failed', detail: String(err) };
	}

	const messaging = await getFirebaseMessaging();
	if (!messaging) return { ok: false, reason: 'fcm-unsupported' };

	let token: string;
	try {
		await ensureSignedIn();
		const t = await getToken(messaging, {
			vapidKey: getVapidKey(),
			serviceWorkerRegistration: registration
		});
		if (!t) return { ok: false, reason: 'token-failed' };
		token = t;
	} catch (err) {
		console.error('[schedule] getToken failed', err);
		return { ok: false, reason: 'token-failed', detail: String(err) };
	}

	try {
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
	} catch (err) {
		console.error('[schedule] registerDevice failed', err);
		return { ok: false, reason: 'firestore-failed', detail: String(err) };
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
