/**
 * Adapter interface for the Firestore-backed schedule store. Lets the upload
 * pipeline (`flushPendingSchedule`) be unit-tested with a fake while the
 * Svelte runtime wires up the real Firebase implementation.
 */
import type { ScheduleItem } from './buildScheduleItem.js';

export interface DeviceRegistration {
	installId: string;
	token: string;
	platform: string;
	scheduleNoteGuid?: string;
}

export interface ScheduleRemoteClient {
	/** Idempotent — overwrites docs at `users/{uid}/schedule/{item.id}`. */
	upsertScheduleItems(items: ScheduleItem[]): Promise<void>;
	/** Idempotent — missing docs are silently no-op. */
	deleteScheduleItems(ids: string[]): Promise<void>;
	/** Upserts `users/{uid}/devices/{installId}`. */
	registerDevice(reg: DeviceRegistration): Promise<void>;
}
