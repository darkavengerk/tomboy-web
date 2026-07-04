import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dragLift } from '$lib/desktop/dragLift.js';

let parent: HTMLElement;
let before: HTMLElement;
let node: HTMLElement;
let after: HTMLElement;
let layer: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	parent = document.createElement('div');
	before = document.createElement('span');
	node = document.createElement('div');
	after = document.createElement('span');
	parent.append(before, node, after);
	layer = document.createElement('div');
	layer.className = 'drag-layer';
	document.body.append(parent, layer);
});

describe('dragLift action', () => {
	it('does not move the node while lifted=false', () => {
		dragLift(node, { lifted: false });
		expect(node.parentElement).toBe(parent);
	});

	it('reparents the node into the target on lift', () => {
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		expect(node.parentElement).toBe(layer);
	});

	it('restores the node to its exact original position on drop', () => {
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		h?.update?.({ lifted: false });
		expect(node.parentElement).toBe(parent);
		// Back between `before` and `after`, same order as before the lift.
		expect(Array.from(parent.children)).toEqual([before, node, after]);
	});

	it('lifts immediately when constructed with lifted=true', () => {
		dragLift(node, { lifted: true });
		expect(node.parentElement).toBe(layer);
	});

	it('accepts an explicit target element', () => {
		const other = document.createElement('div');
		document.body.append(other);
		const h = dragLift(node, { lifted: false, target: other });
		h?.update?.({ lifted: true, target: other });
		expect(node.parentElement).toBe(other);
	});

	it('leaves no placeholder comment in the parent after a round trip', () => {
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		h?.update?.({ lifted: false });
		const comments = Array.from(parent.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
		expect(comments).toHaveLength(0);
	});

	it('cleans up its placeholder if destroyed while lifted', () => {
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		h?.destroy?.();
		const comments = Array.from(parent.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
		expect(comments).toHaveLength(0);
	});

	it('removes the lifted node on destroy (cross-surface MOVE unmount, no zombie left behind)', () => {
		// A cross-surface drop MOVEs the note: its source NoteWindow unmounts while
		// still lifted. The node was re-parented into `.drag-layer`, out of its
		// Svelte block range, so Svelte's own teardown can't reach it — the action
		// must remove it itself or an event-dead "zombie" lingers at the drop spot.
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		expect(node.parentElement).toBe(layer);
		h?.destroy?.();
		expect(node.parentElement).toBeNull();
		expect(layer.children).toHaveLength(0);
	});

	it('prefers the atomic moveBefore (no detach → preserves subtree scroll/focus)', () => {
		// moveBefore (Chrome 133+) moves without detaching, so embedded 묶음/탭
		// scroll + caret survive the reparent. Assert we route through it when present.
		const moved: Array<[Node, Node | null]> = [];
		(layer as unknown as { moveBefore: (n: Node, r: Node | null) => void }).moveBefore = (
			n,
			r
		) => {
			moved.push([n, r]);
			if (r) layer.insertBefore(n, r);
			else layer.appendChild(n);
		};
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		expect(moved).toHaveLength(1);
		expect(moved[0][0]).toBe(node);
		expect(node.parentElement).toBe(layer);
	});

	it('restores descendant scrollTop even when moveBefore is used (moveBefore does NOT preserve scroll)', () => {
		// The bug: moveBefore preserves focus/media but NOT scrollTop, so the
		// embedded 묶음/탭 body still jumped to top. atomicMove must snapshot+restore
		// scroll around BOTH the moveBefore and the plain-move paths.
		const scroller = document.createElement('div');
		let st = 100;
		Object.defineProperty(scroller, 'scrollTop', {
			get: () => st,
			set: (v: number) => {
				st = v;
			},
			configurable: true
		});
		node.appendChild(scroller);
		// moveBefore present AND simulating the real browser: the move reclamps
		// the scroll container to 0.
		(layer as unknown as { moveBefore: (n: Node, r: Node | null) => void }).moveBefore = (
			n,
			r
		) => {
			if (r) layer.insertBefore(n, r);
			else layer.appendChild(n);
			st = 0;
		};
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		expect(scroller.scrollTop).toBe(100); // restored despite moveBefore zeroing it
	});

	it('does NOT re-assert focus/selection the move already preserved (no synthetic events)', () => {
		// moveBefore (Chrome) natively keeps focus + selection across the reparent.
		// Re-asserting them anyway fires synthetic selectionchange/focus events;
		// keepCursorVisible treats those as a real caret move and, on the next
		// pointerup, scrolls the caret (= the user's OLD editing spot) back into
		// view — the "드래그하면 예전 스크롤로 회귀" bug. When the state survived
		// the move, the restore must be a pure no-op.
		const editable = document.createElement('div');
		editable.tabIndex = 0;
		editable.textContent = 'hello';
		node.appendChild(editable);
		editable.focus();
		const sel = window.getSelection()!;
		const r = document.createRange();
		r.setStart(editable.firstChild!, 2);
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);

		// Simulate a perfectly state-preserving atomic move (the node isn't even
		// detached, so focus/selection are guaranteed intact afterwards).
		(layer as unknown as { moveBefore: (n: Node, r: Node | null) => void }).moveBefore =
			() => {};

		const removeSpy = vi.spyOn(sel, 'removeAllRanges');
		const addSpy = vi.spyOn(sel, 'addRange');
		const focusSpy = vi.spyOn(editable, 'focus');

		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });

		expect(removeSpy).not.toHaveBeenCalled();
		expect(addSpy).not.toHaveBeenCalled();
		expect(focusSpy).not.toHaveBeenCalled();
	});

	it('still re-asserts focus/selection when the move dropped them (plain-move path)', () => {
		const editable = document.createElement('div');
		editable.tabIndex = 0;
		editable.textContent = 'hello';
		node.appendChild(editable);
		editable.focus();
		const sel = window.getSelection()!;
		const r = document.createRange();
		r.setStart(editable.firstChild!, 2);
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);

		// Simulate a browser whose move loses the transient state (Firefox plain
		// insertBefore): blur + selection cleared by the "move".
		(layer as unknown as { moveBefore: (n: Node, r: Node | null) => void }).moveBefore = (
			n,
			ref
		) => {
			if (ref) layer.insertBefore(n, ref);
			else layer.appendChild(n);
			(document.activeElement as HTMLElement | null)?.blur();
			sel.removeAllRanges();
		};

		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });

		expect(document.activeElement).toBe(editable);
		expect(sel.rangeCount).toBe(1);
		expect(sel.getRangeAt(0).startContainer).toBe(editable.firstChild);
		expect(sel.getRangeAt(0).startOffset).toBe(2);
	});

	it('falls back to a plain move (still reparents correctly) when moveBefore is absent', () => {
		// Firefox has no moveBefore: the action must still reparent, bracketed by a
		// manual scroll/focus snapshot+restore (behaviour: node ends in the target).
		delete (layer as unknown as { moveBefore?: unknown }).moveBefore;
		delete (parent as unknown as { moveBefore?: unknown }).moveBefore;
		const h = dragLift(node, { lifted: false });
		h?.update?.({ lifted: true });
		expect(node.parentElement).toBe(layer);
		h?.update?.({ lifted: false });
		expect(Array.from(parent.children)).toEqual([before, node, after]);
	});
});
