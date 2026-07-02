// Svelte action: while `lifted` is true, re-parents the node into a top-level
// drag layer so it escapes its ancestors' stacking contexts (`.canvas` /
// `.drawer`, both sealed + `overflow:hidden`) and floats above the drawer
// panels (`--z-drawer`). On `lifted` → false it returns to its EXACT original
// position via a placeholder comment (robust to sibling reorders during the
// drag). The component instance is untouched, so a same-surface drag keeps its
// live TipTap editor (no remount). On a cross-surface drop the component
// unmounts while still lifted; because the node was re-parented OUT of its
// Svelte block range, Svelte's own teardown can't reach it — so destroy() must
// remove the node itself, or an event-dead "zombie" lingers in the drag layer.
//
// The physical move uses `Node.prototype.moveBefore()` (Chrome 133+) — an ATOMIC
// move that never detaches the node, so scrollTop of every scrollable descendant
// (embedded 묶음/탭 `.bundle-body`, the note editor, xterm viewport), the
// contenteditable focus, the caret/selection, and iframe/animation state all
// survive the two reparents a drag performs. Without it, a plain
// appendChild/insertBefore detaches+reattaches the subtree and resets all of the
// above (the "드래그하면 번들 스크롤이 맨 위로" bug). Browsers lacking moveBefore
// (Firefox as of 2026) fall back to a manual snapshot+restore of scroll / focus /
// selection around the plain move — see `atomicMove`.

export interface DragLiftParams {
	lifted: boolean;
	/** Drag-layer target. Defaults to the `.drag-layer` element. */
	target?: HTMLElement | string;
}

function resolveTarget(t: HTMLElement | string | undefined): HTMLElement | null {
	const sel = t ?? '.drag-layer';
	const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
	return el instanceof HTMLElement ? el : null;
}

interface DragDomState {
	scrolls: Array<{ el: Element; top: number; left: number }>;
	activeEl: HTMLElement | null;
	range: Range | null;
}

// Snapshot the transient DOM-layout state a detach+reattach would destroy, so
// the plain-move fallback can put it back. Only records scroll containers that
// are actually scrolled (keeps the list tiny), and only captures focus/selection
// that lives inside `node` (so we never steal it from elsewhere on restore).
function captureDomState(node: HTMLElement): DragDomState {
	const scrolls: DragDomState['scrolls'] = [];
	const record = (el: Element) => {
		if (el.scrollTop || el.scrollLeft) scrolls.push({ el, top: el.scrollTop, left: el.scrollLeft });
	};
	record(node);
	node.querySelectorAll('*').forEach(record);

	const ae = document.activeElement as HTMLElement | null;
	const activeEl = ae && node.contains(ae) ? ae : null;

	let range: Range | null = null;
	const sel = typeof window !== 'undefined' ? window.getSelection() : null;
	if (sel && sel.rangeCount > 0) {
		const r = sel.getRangeAt(0);
		if (node.contains(r.startContainer) && node.contains(r.endContainer)) range = r.cloneRange();
	}
	return { scrolls, activeEl, range };
}

function restoreDomState(node: HTMLElement, s: DragDomState): void {
	for (const { el, top, left } of s.scrolls) {
		if (!el.isConnected) continue;
		el.scrollTop = top;
		el.scrollLeft = left;
	}
	// preventScroll is load-bearing: a plain focus() would scroll an ancestor to
	// reveal the caret and re-introduce the very jump we're preventing.
	if (s.activeEl && s.activeEl.isConnected && node.contains(s.activeEl)) {
		s.activeEl.focus({ preventScroll: true });
	}
	// Only re-apply the caret if its endpoints are still in the (live) DOM — a
	// debounced editor save could have rebuilt the ProseMirror DOM in between.
	if (s.range && s.range.startContainer.isConnected && s.range.endContainer.isConnected) {
		const sel = window.getSelection();
		if (sel) {
			sel.removeAllRanges();
			sel.addRange(s.range);
		}
	}
}

// Move `node` to before `ref` (null = append) inside `parent`. Prefers the
// atomic `moveBefore` (no detach → all subtree state preserved); otherwise
// brackets a plain move with capture/restore so scroll/focus/caret survive.
function atomicMove(parent: Node, node: HTMLElement, ref: Node | null): void {
	const p = parent as Node & { moveBefore?: (n: Node, r: Node | null) => void };
	if (
		typeof p.moveBefore === 'function' &&
		node.isConnected &&
		node.getRootNode() === parent.getRootNode()
	) {
		try {
			p.moveBefore(node, ref);
			return;
		} catch {
			// Some invalid-state cases throw — fall through to the plain move.
		}
	}
	const snap = captureDomState(node);
	if (ref) parent.insertBefore(node, ref);
	else parent.appendChild(node);
	restoreDomState(node, snap);
}

export function dragLift(node: HTMLElement, params: DragLiftParams) {
	let placeholder: Comment | null = null;
	let isLifted = false;

	function lift(target: HTMLElement | string | undefined): void {
		if (isLifted) return;
		const dest = resolveTarget(target);
		if (!dest) return;
		placeholder = document.createComment('drag-lift');
		node.parentNode?.insertBefore(placeholder, node);
		atomicMove(dest, node, null);
		isLifted = true;
	}

	function drop(): void {
		if (!isLifted) return;
		if (placeholder?.parentNode) {
			atomicMove(placeholder.parentNode, node, placeholder);
		}
		placeholder?.remove();
		placeholder = null;
		isLifted = false;
	}

	if (params.lifted) lift(params.target);

	return {
		update(p: DragLiftParams) {
			if (p.lifted && !isLifted) lift(p.target);
			else if (!p.lifted && isLifted) drop();
		},
		destroy() {
			// Unmounted while still lifted (cross-surface MOVE replaced this window):
			// the node sits in the drag layer, outside this block's range, so Svelte
			// won't remove it. Pull it ourselves to avoid an orphaned zombie node.
			if (isLifted && node.parentNode) node.parentNode.removeChild(node);
			placeholder?.remove();
			placeholder = null;
		}
	};
}
