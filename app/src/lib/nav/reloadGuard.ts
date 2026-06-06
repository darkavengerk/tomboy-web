// Bounded auto-reload budget for post-deploy chunk recovery.
//
// When a new build is deployed, the old HTML shell references hashed JS chunks
// that no longer exist on the server. Lazy-importing one fails and Vite fires
// `vite:preloadError`. Recovering means reloading once to fetch the new build —
// but if the reload itself can re-arm the reload, you get an infinite loop
// (which is exactly the regression this replaces: the old guard was cleared on
// every mount, so it never survived a reload).
//
// This budget is the pure decision core: given the previously persisted budget
// and the current time, decide whether ONE more auto-reload is allowed and what
// budget to persist next. It is storage-agnostic and clock-agnostic so it can
// be unit-tested deterministically; the caller wires it to localStorage +
// wall-clock and keys it by build version.

export const RELOAD_WINDOW_MS = 60_000;
export const RELOAD_MAX = 3;

export interface ReloadBudget {
	/** Number of auto-reloads already spent in the current window. */
	count: number;
	/** Epoch-ms timestamp of the first reload in the current window. */
	first: number;
}

export interface ReloadDecision {
	/** Whether the caller may auto-reload now. */
	allow: boolean;
	/** Budget to persist before reloading (or after giving up). */
	next: ReloadBudget;
}

/**
 * Decide whether an auto-reload is permitted.
 *
 * - A fresh window starts when there is no prior budget, or the prior window
 *   has fully elapsed (`now - first >= windowMs`). This lets a long-running
 *   session that hits a *later* deploy get a fresh budget instead of being
 *   starved by reloads from hours ago.
 * - Within a live window, at most `max` reloads are allowed. Once spent, the
 *   caller must stop reloading and surface a manual-recovery affordance — the
 *   loop dies after a hard ceiling rather than running forever.
 *
 * The returned `next` is always safe to persist: on the give-up branch it keeps
 * the exhausted count so repeated preloadErrors within the window keep failing
 * closed (no reload).
 */
export function evaluateReload(
	prev: ReloadBudget | null,
	now: number,
	windowMs: number = RELOAD_WINDOW_MS,
	max: number = RELOAD_MAX
): ReloadDecision {
	const within = prev != null && prev.first !== 0 && now - prev.first < windowMs;
	const count = within ? prev.count : 0;
	const first = within ? prev.first : now;

	if (count >= max) {
		return { allow: false, next: { count, first } };
	}
	return { allow: true, next: { count: count + 1, first } };
}
