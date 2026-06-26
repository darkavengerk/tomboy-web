import { describe, it, expect, beforeEach } from 'vitest';
import { startPointerDrag } from '$lib/desktop/dragResize.js';

beforeEach(() => {
	document.body.innerHTML = '';
});

function fireDown(el: HTMLElement, x: number, y: number): void {
	el.dispatchEvent(
		new MouseEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true })
	);
}

describe('startPointerDrag — survives the pointer leaving the captured element', () => {
	it('keeps firing onMove from window-level pointermove after a reparent (capture lost)', () => {
		const handle = document.createElement('div');
		const layer = document.createElement('div');
		document.body.append(handle, layer);
		const moves: Array<[number, number]> = [];
		handle.addEventListener('pointerdown', (e) => {
			startPointerDrag(e as PointerEvent, { onMove: (dx, dy) => moves.push([dx, dy]) });
		});

		fireDown(handle, 100, 100);
		// Reparent the handle into the "drag layer" — in a real browser this drops
		// the element's pointer capture, so subsequent moves only reach `window`.
		layer.appendChild(handle);
		// Fast move: pointer is now far from `handle`; the event lands on `window`.
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 300 }));

		expect(moves).toEqual([[300, 200]]);
	});

	it('fires onEnd on a window-level pointerup', () => {
		const handle = document.createElement('div');
		document.body.append(handle);
		let ended: { x: number; y: number } | null = null;
		handle.addEventListener('pointerdown', (e) => {
			startPointerDrag(e as PointerEvent, { onMove: () => {}, onEnd: (p) => (ended = p) });
		});

		fireDown(handle, 0, 0);
		window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50, clientY: 60 }));

		expect(ended).toEqual({ x: 50, y: 60 });
	});

	it('stops firing onMove after pointerup', () => {
		const handle = document.createElement('div');
		document.body.append(handle);
		const moves: Array<[number, number]> = [];
		handle.addEventListener('pointerdown', (e) => {
			startPointerDrag(e as PointerEvent, { onMove: (dx, dy) => moves.push([dx, dy]) });
		});

		fireDown(handle, 0, 0);
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 0 }));
		window.dispatchEvent(new MouseEvent('pointerup', { clientX: 10, clientY: 0 }));
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: 99, clientY: 0 }));

		expect(moves).toEqual([[10, 0]]); // the post-up move is ignored
	});
});
