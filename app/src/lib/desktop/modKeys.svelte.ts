let ctrlHeld = $state(false);

function reset(): void {
	ctrlHeld = false;
}

function onKeyDown(e: KeyboardEvent): void {
	if (e.key === 'Control' || e.ctrlKey) ctrlHeld = true;
}

function onKeyUp(e: KeyboardEvent): void {
	if (e.key === 'Control') ctrlHeld = false;
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
	get ctrl(): boolean {
		return ctrlHeld;
	}
};
