import { deviceStateSync } from './deviceStateSync.firestore.js';

/** Thin seam the audio engine + control-note transport hook call into. Kept
 *  separate from the Firestore singleton so unit tests can stub these two
 *  functions without importing the SDK. */
export function reportPlaybackPosition(position: number, trackUrl: string): void {
	deviceStateSync.writePosition(position, trackUrl);
}
export function flushPlaybackPosition(position: number, trackUrl: string): void {
	deviceStateSync.flushPosition(position, trackUrl);
}
