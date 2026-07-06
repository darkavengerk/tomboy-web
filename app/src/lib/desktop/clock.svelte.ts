/**
 * Shared live clock for the desktop rail. A single module-level timer updates a
 * reactive `HH:MM` (24-hour) string that any component can read via `clock.hhmm`.
 * The timer starts lazily on first read and aligns to the minute boundary so it
 * ticks at most once per minute.
 */

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Pure formatter — `HH:MM`, 24-hour, zero-padded. */
export function formatHHMM(d: Date): string {
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let now = $state(typeof window !== 'undefined' ? formatHHMM(new Date()) : '');
let started = false;

function tick(): void {
	now = formatHHMM(new Date());
}

function ensureTimer(): void {
	if (started || typeof window === 'undefined') return;
	started = true;
	tick();
	const d = new Date();
	const delayToMinute = (60 - d.getSeconds()) * 1000 - d.getMilliseconds();
	setTimeout(() => {
		tick();
		setInterval(tick, 60_000);
	}, Math.max(0, delayToMinute));
}

export const clock = {
	/** Current `HH:MM` (24-hour). Starts the shared timer on first read. */
	get hhmm(): string {
		ensureTimer();
		return now;
	}
};
