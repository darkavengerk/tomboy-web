import { getCurrentNoteSyncUid } from '$lib/sync/firebase/noteSyncClient.firestore.js';
import { getOrCreateInstallId } from '$lib/schedule/installId.js';
import { getSetting } from '$lib/storage/appSettings.js';
import { getFirebaseFirestore } from '$lib/firebase/app.js';
import {
	createDeviceStateSync,
	type DeviceStateAdapter,
	type DeviceStateDoc
} from './deviceStateSync.js';

const FIREBASE_NOTES_ENABLED_KEY = 'firebaseNotesEnabled';

const firestoreAdapter: DeviceStateAdapter = {
	async write(uid, deviceId, docData) {
		const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
		await setDoc(
			doc(getFirebaseFirestore(), 'users', uid, 'deviceState', deviceId),
			{ position: docData.position, trackUrl: docData.trackUrl, updatedAt: serverTimestamp() },
			{ merge: true }
		);
	},
	async read(uid, deviceId): Promise<DeviceStateDoc | null> {
		const { doc, getDoc } = await import('firebase/firestore');
		const snap = await getDoc(doc(getFirebaseFirestore(), 'users', uid, 'deviceState', deviceId));
		if (!snap.exists()) return null;
		const d = snap.data() as Record<string, unknown>;
		return {
			position: typeof d.position === 'number' ? d.position : 0,
			trackUrl: typeof d.trackUrl === 'string' ? d.trackUrl : ''
		};
	}
};

/** App-wide singleton. */
export const deviceStateSync = createDeviceStateSync({
	adapter: firestoreAdapter,
	getUid: getCurrentNoteSyncUid,
	isEnabled: async () => (await getSetting<boolean>(FIREBASE_NOTES_ENABLED_KEY)) === true,
	getDeviceId: getOrCreateInstallId,
	now: () => Date.now()
});
