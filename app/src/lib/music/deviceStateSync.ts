/**
 * Channel B — ephemeral cross-device playback position.
 *
 * Writes THIS device's position to users/{uid}/deviceState/{deviceId} at most
 * once per `minIntervalMs` (timeupdate fires ~4×/s; the throttle keeps Firestore
 * writes to ~6/min while playing). Reads another device's position one-shot at
 * resume time. Gated on the same firebaseNotesEnabled + sign-in as note-sync.
 */
export interface DeviceStateDoc {
	position: number;
	trackUrl: string;
}

export interface DeviceStateAdapter {
	write(uid: string, deviceId: string, doc: DeviceStateDoc): Promise<void>;
	read(uid: string, deviceId: string): Promise<DeviceStateDoc | null>;
}

export interface DeviceStateSyncDeps {
	adapter: DeviceStateAdapter;
	getUid: () => Promise<string | null>;
	isEnabled: () => Promise<boolean>;
	getDeviceId: () => Promise<string>;
	now: () => number;
	minIntervalMs?: number;
}

export function createDeviceStateSync(deps: DeviceStateSyncDeps) {
	const minInterval = deps.minIntervalMs ?? 10_000;
	let lastWriteAt = -Infinity;
	let lastUrl = '';

	async function doWrite(position: number, trackUrl: string): Promise<void> {
		// Gate on the setting FIRST and short-circuit before getUid(): getUid is
		// getCurrentNoteSyncUid → ensureSignedIn() (Dropbox-bridged Firebase sign-in,
		// a dropboxAuthExchange Cloud Function call). Running it in parallel would
		// trigger that sign-in every ~10s while playing even when sharing is OFF.
		if (!(await deps.isEnabled())) return;
		const uid = await deps.getUid();
		if (!uid) return;
		const deviceId = await deps.getDeviceId();
		await deps.adapter.write(uid, deviceId, { position: Math.max(0, position), trackUrl });
	}

	return {
		/** Throttled — safe to call on every timeupdate. */
		writePosition(position: number, trackUrl: string): void {
			const t = deps.now();
			if (trackUrl === lastUrl && t - lastWriteAt < minInterval) return;
			lastWriteAt = t; // reserve the slot optimistically (avoid async bursts)
			lastUrl = trackUrl;
			void doWrite(position, trackUrl);
		},
		/** Immediate — pause/stop/seek. */
		flushPosition(position: number, trackUrl: string): void {
			lastWriteAt = deps.now();
			lastUrl = trackUrl;
			void doWrite(position, trackUrl);
		},
		async readDeviceState(deviceId: string): Promise<DeviceStateDoc | null> {
			if (!(await deps.isEnabled())) return null;
			const uid = await deps.getUid();
			if (!uid) return null;
			return deps.adapter.read(uid, deviceId);
		},
		__resetForTest(): void {
			lastWriteAt = -Infinity;
			lastUrl = '';
		}
	};
}
