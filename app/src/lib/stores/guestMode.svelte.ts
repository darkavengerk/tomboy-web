import { getFreshAccessToken } from '$lib/sync/dropboxClient.js';

export type AppMode = 'visitor' | 'guest' | 'host';

export const GUEST_NAME_KEY = 'tomboy.guestName';

function readGuestName(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(GUEST_NAME_KEY);
}

let current = $state<AppMode>('visitor');

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
