import { getFreshAccessToken } from '$lib/sync/dropboxClient.js';

export type AppMode = 'visitor' | 'guest' | 'host';

export const GUEST_NAME_KEY = 'tomboy.guestName';
// Owned by `dropboxClient`, but we read the literal here to avoid a circular
// import at module-load time. Same trick `db.ts:detectInitialDbMode` uses.
const DROPBOX_ACCESS_TOKEN_KEY = 'tomboy-dropbox-access-token';

function readGuestName(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(GUEST_NAME_KEY);
}

/**
 * Synchronous initial-mode detection. Runs at module-load — before the
 * layout's `afterNavigate` fires for the initial navigation, so the
 * visitor-redirect guard doesn't trip on a stale default while the async
 * `detectAndSet()` is still mid-flight.
 *
 * Token presence alone is enough here (a deeper refresh check would have to
 * be async); if the refresh actually fails later, `detectAndSet()` will
 * downgrade the mode and the layout surfaces it as a toast + redirect.
 */
function detectInitialMode(): AppMode {
	if (typeof localStorage === 'undefined') return 'visitor';
	if (localStorage.getItem(DROPBOX_ACCESS_TOKEN_KEY)) return 'host';
	if (localStorage.getItem(GUEST_NAME_KEY)) return 'guest';
	return 'visitor';
}

let current = $state<AppMode>(detectInitialMode());

export const mode = {
	get value(): AppMode {
		return current;
	},
	set(v: AppMode): void {
		current = v;
	},
	async detectAndSet(): Promise<AppMode> {
		const token = await getFreshAccessToken();
		if (token) {
			current = 'host';
		} else if (readGuestName()) {
			current = 'guest';
		} else {
			current = 'visitor';
		}
		return current;
	},
	getGuestName(): string | null {
		return readGuestName();
	},
	setGuestName(name: string): void {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(GUEST_NAME_KEY, name);
	},
	clearGuestName(): void {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(GUEST_NAME_KEY);
	}
};
