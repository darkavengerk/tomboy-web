/**
 * Ephemeral clipboard for slip-note chain-edit operations. Holds a guid
 * plus a mode so the paste site knows whether to do a cut-paste (splice
 * into middle) or a connect-paste (append whole downstream after a TAIL).
 * Not persisted — a leftover clipboard across a tab reload would be
 * confusing, especially since the cut-source's IDB state mutates at cut
 * time and the connect-source's 이전 link is severed at connect-click time.
 */

type ClipboardMode = 'cut' | 'connect';

let entry = $state<{ guid: string; mode: ClipboardMode } | null>(null);

export const slipClipboard = {
	get guid(): string | null {
		return entry?.guid ?? null;
	},
	get mode(): ClipboardMode | null {
		return entry?.mode ?? null;
	},
	get hasEntry(): boolean {
		return entry !== null;
	},

	get cutGuid(): string | null {
		return entry?.mode === 'cut' ? entry.guid : null;
	},
	get hasCut(): boolean {
		return entry?.mode === 'cut';
	},
	get connectGuid(): string | null {
		return entry?.mode === 'connect' ? entry.guid : null;
	},
	get hasConnect(): boolean {
		return entry?.mode === 'connect';
	},

	setCut(guid: string): void {
		entry = { guid, mode: 'cut' };
	},
	setConnect(guid: string): void {
		entry = { guid, mode: 'connect' };
	},
	clear(): void {
		entry = null;
	}
};
