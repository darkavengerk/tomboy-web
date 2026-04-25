/**
 * Cloud Functions entry point.
 *
 * `fireSchedules` runs every minute. It queries the global `schedule`
 * collection group for items whose `fireAt` falls in the next 2-minute
 * window and that haven't been notified yet, sends a Web Push for each via
 * FCM to all of the owning user's registered devices, then marks them
 * notified=true so they don't fire again.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

initializeApp();

const FIRE_WINDOW_MINUTES = 2;
const REGION = 'asia-northeast3';

interface ScheduleDoc {
	fireAt: Timestamp;
	eventAt: Timestamp;
	label: string;
	hasTime: boolean;
	year: number;
	month: number;
	day: number;
	notified: boolean;
}

interface DeviceDoc {
	token: string;
	platform?: string;
	scheduleNoteGuid?: string | null;
}

function formatBody(label: string, eventAt: Timestamp, hasTime: boolean): string {
	if (!hasTime) return label;
	const d = eventAt.toDate();
	// Render in KST regardless of where the function runs.
	const fmt = new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
	return `${fmt.format(d)} ${label}`;
}

export const fireSchedules = onSchedule(
	{
		schedule: 'every 1 minutes',
		timeZone: 'Asia/Seoul',
		region: REGION,
		timeoutSeconds: 60,
		memory: '256MiB'
	},
	async () => {
		const db = getFirestore();
		const messaging = getMessaging();
		const now = Timestamp.now();
		const hi = Timestamp.fromMillis(now.toMillis() + FIRE_WINDOW_MINUTES * 60_000);

		const snap = await db
			.collectionGroup('schedule')
			.where('fireAt', '>=', now)
			.where('fireAt', '<', hi)
			.where('notified', '==', false)
			.limit(500)
			.get();

		if (snap.empty) {
			logger.debug('fireSchedules: nothing in window', { now: now.toDate().toISOString() });
			return;
		}

		// Cache device-token lookups per user across this run.
		const tokenCache = new Map<string, { tokens: string[]; scheduleNoteGuid: string | null }>();

		async function getUserContext(uid: string) {
			const cached = tokenCache.get(uid);
			if (cached) return cached;
			const devices = await db.collection(`users/${uid}/devices`).get();
			const tokens: string[] = [];
			let scheduleNoteGuid: string | null = null;
			devices.forEach((d) => {
				const data = d.data() as DeviceDoc;
				if (data.token) tokens.push(data.token);
				if (data.scheduleNoteGuid) scheduleNoteGuid = data.scheduleNoteGuid;
			});
			const ctx = { tokens, scheduleNoteGuid };
			tokenCache.set(uid, ctx);
			return ctx;
		}

		const writes: Promise<unknown>[] = [];

		for (const doc of snap.docs) {
			const data = doc.data() as ScheduleDoc;
			// users/{uid}/schedule/{itemId}
			const uid = doc.ref.parent.parent?.id;
			if (!uid) continue;
			const { tokens, scheduleNoteGuid } = await getUserContext(uid);
			if (tokens.length === 0) {
				// No registered device; mark notified=true anyway so we don't
				// keep re-scanning the same row.
				writes.push(doc.ref.update({ notified: true }));
				continue;
			}

			const body = formatBody(data.label, data.eventAt, data.hasTime);
			try {
				const result = await messaging.sendEachForMulticast({
					tokens,
					notification: { title: '일정', body },
					data: {
						itemId: doc.id,
						label: data.label,
						eventAt: data.eventAt.toDate().toISOString(),
						scheduleNoteGuid: scheduleNoteGuid ?? ''
					},
					webpush: {
						headers: { Urgency: 'high', TTL: '600' },
						notification: { requireInteraction: false, tag: doc.id },
						fcmOptions: scheduleNoteGuid
							? { link: `/note/${scheduleNoteGuid}?from=notes` }
							: undefined
					}
				});
				const errs = result.responses
					.map((r) => r.error?.message)
					.filter(Boolean);
				logger.info('fireSchedules sent', {
					uid,
					itemId: doc.id,
					success: result.successCount,
					failure: result.failureCount,
					errors: errs
				});
			} catch (err) {
				logger.error('fireSchedules send failed', { uid, itemId: doc.id, err });
			}
			writes.push(doc.ref.update({ notified: true }));
		}

		await Promise.all(writes);
	}
);

/**
 * `dropboxAuthExchange` — callable that takes a Dropbox access token,
 * verifies it against the Dropbox API, and returns a Firebase Custom Auth
 * token whose uid is derived from the Dropbox `account_id`.
 *
 * Why: we want the same Firebase uid across all devices that share a
 * Dropbox account so schedule items and device tokens land under one
 * users/{uid}/ namespace. Anonymous Auth gives a per-device uid which
 * isolates data to that device — incompatible with multi-device alarms.
 *
 * The returned uid is `dbx-{sanitized account_id}`. Custom claims include
 * the raw account_id and provider name for any future fanout logic.
 */
export const dropboxAuthExchange = onCall(
	{ region: REGION, timeoutSeconds: 30, memory: '256MiB', cors: true },
	async (request) => {
		logger.info('dropboxAuthExchange invoked', {
			hasData: !!request.data,
			authUid: request.auth?.uid ?? null
		});
		const { dropboxAccessToken } = (request.data ?? {}) as {
			dropboxAccessToken?: string;
		};
		if (!dropboxAccessToken || typeof dropboxAccessToken !== 'string') {
			logger.warn('dropboxAuthExchange: missing dropboxAccessToken');
			throw new HttpsError('invalid-argument', 'dropboxAccessToken required');
		}

		// Verify the token with Dropbox. `users/get_current_account` is the
		// canonical "who are you" endpoint and returns account_id (stable per
		// Dropbox account, never changes for a user).
		// Use explicit Content-Length: 0 to avoid 400 on environments where
		// some HTTP clients omit it for body-less POSTs.
		let account: { account_id?: string; name?: { display_name?: string } };
		try {
			const resp = await fetch(
				'https://api.dropboxapi.com/2/users/get_current_account',
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${dropboxAccessToken}`,
						'Content-Length': '0'
					}
				}
			);
			const bodyText = await resp.text();
			if (!resp.ok) {
				logger.warn('dropboxAuthExchange: Dropbox API rejected', {
					status: resp.status,
					body: bodyText.slice(0, 500)
				});
				// Detect the missing-scope case so the client can guide the
				// user to re-authenticate Dropbox (one-time migration when
				// account_info.read scope was added to the OAuth request).
				if (bodyText.includes('missing_scope')) {
					throw new HttpsError(
						'failed-precondition',
						'dropbox-scope-missing'
					);
				}
				throw new HttpsError(
					'unauthenticated',
					`Dropbox token invalid (HTTP ${resp.status}): ${bodyText.slice(0, 200)}`
				);
			}
			try {
				account = JSON.parse(bodyText);
			} catch (err) {
				logger.warn('dropboxAuthExchange: Dropbox response not JSON', {
					body: bodyText.slice(0, 500)
				});
				throw new HttpsError('internal', 'Dropbox response not JSON');
			}
		} catch (err) {
			if (err instanceof HttpsError) throw err;
			logger.error('dropboxAuthExchange: fetch failed', { err: String(err) });
			throw new HttpsError(
				'unavailable',
				`Dropbox API call failed: ${String(err)}`
			);
		}

		const accountId = account.account_id;
		if (!accountId) {
			logger.warn('dropboxAuthExchange: no account_id in response', { account });
			throw new HttpsError(
				'failed-precondition',
				'No account_id in Dropbox response'
			);
		}

		// Firebase uid: 1-128 chars, no fixed charset rules but practical safe set.
		// Dropbox account_id starts with "dbid:" then base64url. Sanitize to
		// `dbx-` prefix + alphanumerics from the original.
		const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
		const uid = `dbx-${sanitized}`.slice(0, 128);

		try {
			const customToken = await getAuth().createCustomToken(uid, {
				provider: 'dropbox',
				dropboxAccountId: accountId
			});
			logger.info('dropboxAuthExchange success', {
				uid,
				displayName: account.name?.display_name
			});
			return { customToken, uid };
		} catch (err) {
			logger.error('dropboxAuthExchange: createCustomToken failed', {
				err: String(err),
				uid
			});
			throw new HttpsError(
				'internal',
				`createCustomToken failed: ${String(err)}`
			);
		}
	}
);

/**
 * `sendTestPush` — callable that sends a single test FCM message to every
 * device registered for the calling user. Used by the settings-page "테스트
 * 푸시" button to verify the full FCM round-trip independently of the
 * scheduler. Returns counts so the UI can surface delivery status.
 */
export const sendTestPush = onCall(
	{ region: REGION, timeoutSeconds: 30, memory: '256MiB' },
	async (request) => {
		const uid = request.auth?.uid;
		if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');

		const db = getFirestore();
		const messaging = getMessaging();

		const devices = await db.collection(`users/${uid}/devices`).get();
		const tokens: string[] = [];
		devices.forEach((d) => {
			const t = (d.data() as { token?: string }).token;
			if (t) tokens.push(t);
		});
		if (tokens.length === 0) {
			throw new HttpsError('failed-precondition', '등록된 기기가 없습니다.');
		}

		const result = await messaging.sendEachForMulticast({
			tokens,
			notification: {
				title: '테스트 알림',
				body: 'FCM 푸시가 정상적으로 도착했습니다.'
			},
			data: { test: 'true' },
			webpush: {
				headers: {
					// High urgency tells the push service (incl. APNs) to
					// deliver immediately rather than batch.
					Urgency: 'high',
					// 5 min — short TTL so a stale subscription fails fast
					// rather than queuing for days.
					TTL: '300'
				}
				// Note: omitting `notification.requireInteraction` because
				// iOS Safari rejects/ignores it on Web Push and some SDK
				// versions silently drop the entire payload when present.
			}
		});

		const responseDetails = result.responses.map((r, i) => ({
			ok: r.success,
			messageId: r.messageId,
			errorCode: r.error?.code,
			errorMessage: r.error?.message,
			tokenPrefix: tokens[i].slice(0, 16) + '…'
		}));
		logger.info('sendTestPush result', {
			uid,
			tokenCount: tokens.length,
			success: result.successCount,
			failure: result.failureCount,
			details: responseDetails
		});
		return {
			tokenCount: tokens.length,
			successCount: result.successCount,
			failureCount: result.failureCount,
			details: responseDetails,
			errors: responseDetails
				.map((d) => d.errorMessage)
				.filter(Boolean) as string[]
		};
	}
);
