/**
 * Convenience wrapper that drains any pending schedule diff to Firestore,
 * but only when the user has explicitly enabled notifications. Wired into
 * the editor save hook and into a window `online` listener.
 */
import { flushPendingScheduleState, type FlushResult } from './flushPendingSchedule.js';
import { firestoreScheduleClient } from './firestoreScheduleClient.js';
import { isNotificationsEnabled } from './notification.js';

export async function flushIfEnabled(): Promise<FlushResult | null> {
	if (!(await isNotificationsEnabled())) return null;
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
	return flushPendingScheduleState(firestoreScheduleClient);
}

/** Idempotent listener registration. Call once at app start. */
let onlineListenerInstalled = false;
export function installOnlineFlushListener(): void {
	if (onlineListenerInstalled) return;
	if (typeof window === 'undefined') return;
	window.addEventListener('online', () => {
		void flushIfEnabled();
	});
	onlineListenerInstalled = true;
}
