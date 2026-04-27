/**
 * Real Firestore-backed `ScheduleRemoteClient`. Writes under
 *   users/{uid}/schedule/{itemId}
 *   users/{uid}/devices/{installId}
 *
 * Server-side: a Cloud Function with a `collectionGroup('schedule')` query
 * scans for items in the next firing window and sends FCM. See
 * `functions/src/fireSchedules.ts`.
 *
 * The schedule item Firestore shape:
 *   { fireAt: Timestamp, eventAt: Timestamp, label, hasTime, year, month, day,
 *     scheduleNoteGuid, notified: false, createdAt: serverTimestamp }
 */
import {
	deleteDoc,
	doc,
	serverTimestamp,
	setDoc,
	Timestamp,
	writeBatch
} from 'firebase/firestore';
import { ensureSignedIn, getFirebaseFirestore } from '$lib/firebase/app.js';
import type { DeviceRegistration, ScheduleRemoteClient } from './scheduleClient.js';
import type { ScheduleItem } from './buildScheduleItem.js';

async function uid(): Promise<string> {
	const u = await ensureSignedIn();
	return u.uid;
}

export const firestoreScheduleClient: ScheduleRemoteClient = {
	async upsertScheduleItems(items: ScheduleItem[]): Promise<void> {
		if (items.length === 0) return;
		const u = await uid();
		const db = getFirebaseFirestore();
		// Batched write — atomic up to 500 ops, more than enough for our
		// single-user single-note scale.
		const batch = writeBatch(db);
		for (const it of items) {
			const ref = doc(db, 'users', u, 'schedule', it.id);
			batch.set(ref, {
				fireAt: Timestamp.fromDate(new Date(it.fireAt)),
				eventAt: Timestamp.fromDate(new Date(it.eventAt)),
				label: it.label,
				hasTime: it.hasTime,
				year: it.year,
				month: it.month,
				day: it.day,
				notified: false,
				createdAt: serverTimestamp()
			});
		}
		await batch.commit();
	},

	async deleteScheduleItems(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const u = await uid();
		const db = getFirebaseFirestore();
		await Promise.all(
			ids.map((id) => deleteDoc(doc(db, 'users', u, 'schedule', id)))
		);
	},

	async registerDevice(reg: DeviceRegistration): Promise<void> {
		const u = await uid();
		const db = getFirebaseFirestore();
		await setDoc(
			doc(db, 'users', u, 'devices', reg.installId),
			{
				token: reg.token,
				platform: reg.platform,
				scheduleNoteGuid: reg.scheduleNoteGuid ?? null,
				updatedAt: serverTimestamp()
			},
			{ merge: true }
		);
	}
};
