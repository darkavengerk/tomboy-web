/**
 * Pure pointer-events helpers for window drag & resize.
 *
 * We deliberately avoid an external library — the requirements are narrow
 * (one drag handle, one SE resize grip) and pointer events + pointer capture
 * are well-supported on the target desktop browsers.
 */

export interface DragCallbacks {
	onMove: (dx: number, dy: number) => void;
	onEnd?: () => void;
}

/**
 * Starts a drag gesture on the current pointer. `onMove` receives dx/dy
 * relative to the pointerdown position. The handler installs pointer capture
 * on the element that received the event so the drag continues even when
 * the pointer leaves the element (e.g. moved too fast off the title bar).
 */
export function startPointerDrag(e: PointerEvent, { onMove, onEnd }: DragCallbacks): void {
	// Ignore non-primary buttons (right-click, middle-click).
	if (e.button !== 0) return;
	const target = e.currentTarget as HTMLElement | null;
	if (!target) return;

	e.preventDefault();
	try {
		target.setPointerCapture(e.pointerId);
	} catch {
		/* some browsers/test envs throw — drag still works without capture */
	}

	const startX = e.clientX;
	const startY = e.clientY;

	const handleMove = (ev: PointerEvent) => {
		onMove(ev.clientX - startX, ev.clientY - startY);
	};

	const handleUp = (ev: PointerEvent) => {
		try {
			target.releasePointerCapture(ev.pointerId);
		} catch {
			/* noop */
		}
		target.removeEventListener('pointermove', handleMove);
		target.removeEventListener('pointerup', handleUp);
		target.removeEventListener('pointercancel', handleUp);
		onEnd?.();
	};

	target.addEventListener('pointermove', handleMove);
	target.addEventListener('pointerup', handleUp);
	target.addEventListener('pointercancel', handleUp);
}
