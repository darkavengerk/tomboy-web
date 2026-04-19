/**
 * Ephemeral clipboard for slip-note "cut" operations. The cut note's GUID
 * lives in memory until the user pastes it somewhere, or until the tab
 * reloads. Not persisted — a cut across a reload would be confusing.
 */

let cutGuid = $state<string | null>(null);

export const slipClipboard = {
	get cutGuid(): string | null {
		return cutGuid;
	},
	get hasCut(): boolean {
		return cutGuid !== null;
	},
	set(guid: string): void {
		cutGuid = guid;
	},
	clear(): void {
		cutGuid = null;
	}
};
