/**
 * Pure pointer-events helpers for window drag & resize.
 *
 * We deliberately avoid an external library — the requirements are narrow
 * (one drag handle, 8-way resize grips) and pointer events + pointer capture
 * are well-supported on the target desktop browsers.
 */

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Geometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Compute the new window geometry given a starting geometry, resize direction,
 * and pointer deltas. North/West handles shift x/y so the opposite edge stays
 * pinned; min-width/min-height clamps preserve that pinning too.
 */
export function applyResize(
	base: Geometry,
	dir: ResizeDir,
	dx: number,
	dy: number,
	min: { width: number; height: number }
): Geometry {
	const touchesN = dir === 'n' || dir === 'ne' || dir === 'nw';
	const touchesS = dir === 's' || dir === 'se' || dir === 'sw';
	const touchesE = dir === 'e' || dir === 'ne' || dir === 'se';
	const touchesW = dir === 'w' || dir === 'nw' || dir === 'sw';

	let { x, y, width, height } = base;

	if (touchesE) width = base.width + dx;
	if (touchesW) {
		width = base.width - dx;
		x = base.x + dx;
	}
	if (touchesS) height = base.height + dy;
	if (touchesN) {
		height = base.height - dy;
		y = base.y + dy;
	}

	if (width < min.width) {
		if (touchesW) x = base.x + base.width - min.width;
		width = min.width;
	}
	if (height < min.height) {
		if (touchesN) y = base.y + base.height - min.height;
		height = min.height;
	}

	return { x, y, width, height };
}

export interface DragCallbacks {
	onMove: (dx: number, dy: number) => void;
	onEnd?: (pointer: { x: number; y: number }) => void;
}

/**
 * Starts a drag gesture on the current pointer. `onMove` receives dx/dy
 * relative to the pointerdown position.
 *
 * The move/up listeners live on `window`, NOT on the element — so the drag
 * keeps tracking no matter how fast the pointer moves or where it goes. Pointer
 * capture on the element is best-effort only: it's released the moment the
 * element is re-parented (e.g. drag-lift moving the window into `.drag-layer`),
 * which would silently freeze an element-listener drag on a fast flick. Captured
 * events still bubble to `window`, and uncaptured events reach `window` too, so
 * a window listener is the one reliable channel for both cases.
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
		window.removeEventListener('pointermove', handleMove);
		window.removeEventListener('pointerup', handleUp);
		window.removeEventListener('pointercancel', handleUp);
		onEnd?.({ x: ev.clientX, y: ev.clientY });
	};

	window.addEventListener('pointermove', handleMove);
	window.addEventListener('pointerup', handleUp);
	window.addEventListener('pointercancel', handleUp);
}
