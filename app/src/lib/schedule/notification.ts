/**
 * User-facing flow to enable / disable schedule push notifications.
 * Called from the settings page.
 *
 * iOS PWA quirk — `Notification.requestPermission()` MUST be called before
 * any other `await` after the click event, otherwise WebKit treats the
 * permission prompt as untrusted and silently drops it. So we call it as
 * the very first async step, before touching Firebase at all.
 */
import { deleteToken, getToken, onMessage } from 'firebase/messaging';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getSetting, setSetting, deleteSetting } from '$lib/storage/appSettings.js';
import {
	DropboxNotConnectedError,
	ensureSignedIn,
	getFirebaseApp,
	getFirebaseMessaging,
	getVapidKey
} from './firebase.js';
import { firestoreScheduleClient } from './firestoreScheduleClient.js';
import { getOrCreateInstallId } from './installId.js';
import { getScheduleNoteGuid } from '$lib/core/schedule.js';
import { clearScheduleSnapshot } from './scheduleSnapshot.js';

const LAST_FB_UID_KEY = 'schedule.lastFirebaseUid';

export interface TestPushDetail {
	ok: boolean;
	messageId?: string;
	errorCode?: string;
	errorMessage?: string;
	tokenPrefix?: string;
}

export interface TestPushResult {
	tokenCount: number;
	successCount: number;
	failureCount: number;
	details?: TestPushDetail[];
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

/** Inspect the underlying Web Push subscription. Lets us confirm the
 * subscription is registered with the correct push service (e.g.
 * `web.push.apple.com` for iOS Safari) and uses the same VAPID public key
 * we expect. Mismatches here are the usual cause of "FCM accepts but device
 * never receives" on iOS PWA. */
export interface PushSubscriptionDiagnostics {
	hasSubscription: boolean;
	endpoint?: string;
	endpointHost?: string;
	expirationTime?: number | null;
	applicationServerKeyPrefix?: string;
	configuredVapidKeyPrefix: string;
}

export async function getPushSubscriptionDiagnostics(): Promise<PushSubscriptionDiagnostics> {
	const configuredVapidKeyPrefix = (getVapidKey() ?? '').slice(0, 12);
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return { hasSubscription: false, configuredVapidKeyPrefix };
	}
	const reg = await navigator.serviceWorker.ready;
	const sub = await reg.pushManager.getSubscription();
	if (!sub) return { hasSubscription: false, configuredVapidKeyPrefix };
	const ask = sub.options?.applicationServerKey;
	let applicationServerKeyPrefix: string | undefined;
	if (ask) {
		// applicationServerKey is an ArrayBuffer; render the first bytes as
		// base64url for a coarse comparison with the VAPID key string.
		const bytes = new Uint8Array(ask);
		applicationServerKeyPrefix = btoa(String.fromCharCode(...bytes.slice(0, 9)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}
	let endpointHost: string | undefined;
	try {
		endpointHost = new URL(sub.endpoint).host;
	} catch {
		/* ignore */
	}
	return {
		hasSubscription: true,
		endpoint: sub.endpoint,
		endpointHost,
		expirationTime: sub.expirationTime,
		applicationServerKeyPrefix,
		configuredVapidKeyPrefix
	};
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
	| 'sw-timeout'
	| 'dropbox-not-connected'
	| 'dropbox-scope-missing'
	| 'auth-failed'
	| 'token-failed'
	| 'firestore-failed';

/**
 * Wraps a promise with a deadline so a hanging step (e.g. iOS Safari
 * sometimes never resolves `pushManager.subscribe()` if its push state
 * gets into a weird half-installed mode) surfaces as a clear error
 * instead of a silently-disabled button.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`timeout(${ms}ms): ${label}`));
		}, ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

/**
 * Step-progress callback. The settings UI plumbs this through so the
 * user sees which await is currently in flight (helps diagnose iOS hangs
 * without devtools).
 */
export type EnableProgress = (step: string) => void;

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

export async function enableNotifications(
	onProgress?: EnableProgress
): Promise<EnableResult> {
	const step = (label: string) => {
		console.info('[schedule] step:', label);
		onProgress?.(label);
	};

	step('진단');
	const diag = getNotificationDiagnostics();
	console.info('[schedule] enableNotifications: diagnostics', diag);

	if (!diag.hasWindow) return { ok: false, reason: 'no-window' };
	if (!diag.hasNotificationApi) return { ok: false, reason: 'no-notification-api' };
	if (!diag.hasServiceWorker) return { ok: false, reason: 'no-service-worker' };

	const isLikelyIOS = /iPad|iPhone|iPod/.test(diag.userAgent);
	if (isLikelyIOS && !diag.standalone) {
		return { ok: false, reason: 'not-pwa-installed' };
	}

	// CRITICAL: gesture-first. Call requestPermission as the very first
	// async step. Any prior `await` would break iOS Safari's user-activation
	// trust and the prompt would never appear.
	step('권한 요청');
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

	step('SW 준비');
	let registration: ServiceWorkerRegistration;
	try {
		registration = await withTimeout(
			navigator.serviceWorker.ready,
			15_000,
			'serviceWorker.ready'
		);
	} catch (err) {
		console.error('[schedule] SW not ready', err);
		return { ok: false, reason: 'sw-timeout', detail: String(err) };
	}

	step('FCM 초기화');
	const messaging = await getFirebaseMessaging();
	if (!messaging) return { ok: false, reason: 'fcm-unsupported' };

	step('Firebase 로그인 (Dropbox 인증 사용)');
	let user;
	try {
		user = await withTimeout(ensureSignedIn(), 20_000, 'ensureSignedIn');
	} catch (err) {
		if (err instanceof DropboxNotConnectedError) {
			return { ok: false, reason: 'dropbox-not-connected' };
		}
		// Specific case for the one-time scope migration: server returned
		// `failed-precondition: dropbox-scope-missing`. Surface a dedicated
		// reason so the UI can guide the user to re-authenticate Dropbox.
		const errStr = String(err);
		if (errStr.includes('dropbox-scope-missing') || errStr.includes('missing_scope')) {
			return { ok: false, reason: 'dropbox-scope-missing', detail: errStr };
		}
		console.error('[schedule] ensureSignedIn failed', err);
		return { ok: false, reason: 'auth-failed', detail: String(err) };
	}

	// Migrate snapshot if uid changed since last enable. Otherwise the
	// next save would diff against a snapshot uploaded under the old uid
	// and skip uploading anything to Firestore under the new uid.
	const lastUid = await getSetting<string>(LAST_FB_UID_KEY);
	if (lastUid && lastUid !== user.uid) {
		const scheduleNoteGuid = await getScheduleNoteGuid();
		if (scheduleNoteGuid) {
			console.info('[schedule] uid changed, clearing schedule snapshot for migration', {
				lastUid,
				newUid: user.uid
			});
			await clearScheduleSnapshot(scheduleNoteGuid);
		}
	}
	await setSetting(LAST_FB_UID_KEY, user.uid);

	step('FCM 토큰 발급');
	let token: string;
	try {
		const t = await withTimeout(
			getToken(messaging, {
				vapidKey: getVapidKey(),
				serviceWorkerRegistration: registration
			}),
			30_000,
			'getToken'
		);
		if (!t) return { ok: false, reason: 'token-failed' };
		token = t;
	} catch (err) {
		console.error('[schedule] getToken failed', err);
		return { ok: false, reason: 'token-failed', detail: String(err) };
	}

	step('구독 검증');
	const subscription = await registration.pushManager.getSubscription();
	if (!subscription) {
		console.error(
			'[schedule] getToken returned but pushManager has no subscription'
		);
		return {
			ok: false,
			reason: 'token-failed',
			detail: 'Push subscription was not created. Try Force 재구독.'
		};
	}
	console.info('[schedule] push subscription confirmed', {
		endpointHost: new URL(subscription.endpoint).host
	});

	step('Firestore 디바이스 등록');
	try {
		const installId = await getOrCreateInstallId();
		const scheduleNoteGuid = await getScheduleNoteGuid();
		await withTimeout(
			firestoreScheduleClient.registerDevice({
				installId,
				token,
				platform: navigator.userAgent,
				scheduleNoteGuid
			}),
			15_000,
			'registerDevice'
		);
		await setSetting(FCM_TOKEN_KEY, token);
		await setSetting(NOTIF_ENABLED_KEY, true);
		step('완료');
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

/**
 * Aggressively reset push state and re-enable. Use when the device shows
 * `hasSubscription: false` despite a stored token — the FCM SDK has a
 * cached token that no longer corresponds to a live push subscription.
 *
 * Steps:
 *   1. Unsubscribe any existing pushManager subscription (frees iOS state).
 *   2. Tell FCM SDK to delete its cached token (so the next getToken call
 *      actually re-subscribes).
 *   3. Clear our local "enabled" flag and stored token.
 *   4. Call enableNotifications() to start fresh.
 */
export async function forceResubscribe(
	onProgress?: EnableProgress
): Promise<EnableResult> {
	if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
		try {
			const reg = await navigator.serviceWorker.ready;
			const existing = await reg.pushManager.getSubscription();
			if (existing) {
				await existing.unsubscribe();
				console.info('[schedule] unsubscribed existing push subscription');
			}
		} catch (err) {
			console.warn('[schedule] unsubscribe step failed (continuing)', err);
		}
	}
	try {
		const messaging = await getFirebaseMessaging();
		if (messaging) {
			await deleteToken(messaging);
			console.info('[schedule] FCM token cache cleared');
		}
	} catch (err) {
		console.warn('[schedule] deleteToken failed (continuing)', err);
	}
	await disableNotifications();
	return enableNotifications(onProgress);
}

/**
 * Subscribe to foreground push messages — toast only.
 *
 * iOS Web Push semantics:
 *   - Background: OS auto-displays the FCM `notification.title/body` from
 *     the payload. SW's onBackgroundMessage is for data routing only;
 *     calling showNotification there produces a duplicate.
 *   - Foreground: OS does NOT auto-display; FCM's `onMessage` fires on
 *     the page. Showing a system notification while the user already has
 *     the app open is intrusive, so we just toast.
 */
export async function subscribeForegroundMessages(
	handler?: (payload: {
		title?: string;
		body?: string;
		data?: Record<string, string>;
	}) => void
): Promise<() => void> {
	const messaging = await getFirebaseMessaging();
	if (!messaging) return () => {};
	const unsub = onMessage(messaging, (payload) => {
		const title = payload.notification?.title;
		const body = payload.notification?.body;
		const data = payload.data as Record<string, string> | undefined;
		console.info('[schedule] foreground push', { title, body, data });
		handler?.({ title, body, data });
	});
	return unsub;
}
