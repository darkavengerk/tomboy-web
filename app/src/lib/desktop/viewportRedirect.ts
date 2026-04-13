import { goto } from '$app/navigation';

const FLAG_KEY = 'desktopRedirectApplied';
const DESKTOP_MIN_WIDTH = 1200;

/**
 * On app entry, redirect desktop-width viewports to `/desktop` once per session.
 *
 * - Only runs in the browser (no-op on SSR/static build time).
 * - The sessionStorage flag ensures the redirect fires at most once per tab
 *   session so the user can freely navigate to mobile routes afterwards.
 * - Uses `replaceState:true` to avoid creating a back-button loop.
 */
export function maybeRedirectToDesktop(pathname: string): void {
	if (typeof window === 'undefined') return;

	// If user lands directly on /desktop, mark the session so subsequent
	// navigation to mobile routes isn't hijacked by this function.
	if (pathname.startsWith('/desktop')) {
		sessionStorage.setItem(FLAG_KEY, '1');
		return;
	}

	if (sessionStorage.getItem(FLAG_KEY) === '1') return;
	if (window.innerWidth < DESKTOP_MIN_WIDTH) return;

	sessionStorage.setItem(FLAG_KEY, '1');
	void goto('/desktop', { replaceState: true });
}
