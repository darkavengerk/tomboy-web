let ctrlHeldByKey = $state(false);
let altHeldByKey = $state(false);
let ctrlLocked = $state(false);
let altLocked = $state(false);

function reset(): void {
	ctrlHeldByKey = false;
	altHeldByKey = false;
}

function onKeyDown(e: KeyboardEvent): void {
	if (e.key === 'Control' || e.ctrlKey) ctrlHeldByKey = true;
	if (e.key === 'Alt' || e.altKey) altHeldByKey = true;
}

function onKeyUp(e: KeyboardEvent): void {
	if (e.key === 'Control') ctrlHeldByKey = false;
	if (e.key === 'Alt') altHeldByKey = false;
}

let installCount = 0;

export function installModKeyListeners(): () => void {
	if (installCount++ === 0) {
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		window.addEventListener('blur', reset);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') reset();
		});
	}
	return () => {
		if (--installCount === 0) {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', reset);
		}
	};
}

export const modKeys = {
	/** True while Ctrl is physically held OR the mobile Ctrl-lock is on. */
	get ctrl(): boolean {
		return ctrlHeldByKey || ctrlLocked;
	},
	/** True only when the mobile Ctrl-lock is toggled on. */
	get ctrlLocked(): boolean {
		return ctrlLocked;
	},
	/** True while Alt is physically held OR the mobile Alt-lock is on. */
	get alt(): boolean {
		return altHeldByKey || altLocked;
	},
	/** True only when the mobile Alt-lock is toggled on. */
	get altLocked(): boolean {
		return altLocked;
	},
	toggleCtrlLock(): void {
		ctrlLocked = !ctrlLocked;
		if (ctrlLocked) altLocked = false;
	},
	setCtrlLock(v: boolean): void {
		ctrlLocked = v;
		if (v) altLocked = false;
	},
	toggleAltLock(): void {
		altLocked = !altLocked;
		if (altLocked) ctrlLocked = false;
	},
	setAltLock(v: boolean): void {
		altLocked = v;
		if (v) ctrlLocked = false;
	}
};
