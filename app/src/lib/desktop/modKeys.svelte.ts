let ctrlHeldByKey = $state(false);
let ctrlLocked = $state(false);

function reset(): void {
	ctrlHeldByKey = false;
}

function onKeyDown(e: KeyboardEvent): void {
	if (e.key === 'Control' || e.ctrlKey) ctrlHeldByKey = true;
}

function onKeyUp(e: KeyboardEvent): void {
	if (e.key === 'Control') ctrlHeldByKey = false;
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
	toggleCtrlLock(): void {
		ctrlLocked = !ctrlLocked;
	},
	setCtrlLock(v: boolean): void {
		ctrlLocked = v;
	}
};

