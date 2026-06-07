/**
 * Module reactive state for the desktop 펼쳐보기 (spread view) overlay.
 *
 * Transient + session-only — never persisted. The overlay is a pure read-only
 * layer over the current workspace; closing it leaves every window untouched.
 */
let open = $state(false);

export const spreadView = {
	get isOpen(): boolean {
		return open;
	},
	open(): void {
		open = true;
	},
	close(): void {
		open = false;
	},
	toggle(): void {
		open = !open;
	}
};
