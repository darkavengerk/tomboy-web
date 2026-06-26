import { describe, it, expect, beforeEach } from 'vitest';
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
});
