export type AppMode = 'home' | 'sleepnote' | 'notes';

const STORAGE_KEY = 'tomboy:appMode';

function readInitial(): AppMode {
	if (typeof sessionStorage === 'undefined') return 'home';
	const v = sessionStorage.getItem(STORAGE_KEY);
	return v === 'sleepnote' || v === 'notes' ? v : 'home';
}

let current = $state<AppMode>(readInitial());

export const appMode = {
	get value(): AppMode {
		return current;
	},
	set(m: AppMode) {
		current = m;
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.setItem(STORAGE_KEY, m);
		}
	}
};

/** Derive mode from URL; returns null if URL doesn't imply a specific mode. */
export function modeFromUrl(pathname: string, searchParams: URLSearchParams): AppMode | null {
	if (pathname === '/') return 'home';
	if (pathname === '/sleepnote' || pathname.startsWith('/sleepnote/')) return 'sleepnote';
	if (pathname === '/notes' || pathname.startsWith('/notes/')) return 'notes';
	if (pathname.startsWith('/note/')) {
		const from = searchParams.get('from');
		if (from === 'home' || from === 'sleepnote' || from === 'notes') return from;
	}
	return null;
}
