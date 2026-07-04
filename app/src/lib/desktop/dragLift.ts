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

interface SelSnapshot {
	startContainer: Node;
	startOffset: number;
	endContainer: Node;
	endOffset: number;
}

interface DragDomState {
	scrolls: Array<{ el: Element; top: number; left: number }>;
	activeEl: HTMLElement | null;
	sel: SelSnapshot | null;
}

// Snapshot the transient DOM-layout state a detach+reattach would destroy, so
// the plain-move fallback can put it back. Only records scroll containers that
// are actually scrolled (keeps the list tiny), and only captures focus/selection
// that lives inside `node` (so we never steal it from elsewhere on restore).
//
// The selection is stored as PLAIN boundary refs, NOT a cloned Range: the spec's
// range fixup rewrites every live Range whose boundaries sit inside a removed
// subtree (a plain move = remove + insert) to point at the OLD PARENT — clones
// included. Restoring such a fixed-up Range would park the caret outside the
// editor at the window's previous container. Plain {node, offset} refs are
// immune to the fixup.
function captureDomState(node: HTMLElement): DragDomState {
	const scrolls: DragDomState['scrolls'] = [];
	const record = (el: Element) => {
		if (el.scrollTop || el.scrollLeft) scrolls.push({ el, top: el.scrollTop, left: el.scrollLeft });
	};
	record(node);
	node.querySelectorAll('*').forEach(record);

	const ae = document.activeElement as HTMLElement | null;
	const activeEl = ae && node.contains(ae) ? ae : null;

	let snap: SelSnapshot | null = null;
	const sel = typeof window !== 'undefined' ? window.getSelection() : null;
	if (sel && sel.rangeCount > 0) {
		const r = sel.getRangeAt(0);
		if (node.contains(r.startContainer) && node.contains(r.endContainer)) {
			snap = {
				startContainer: r.startContainer,
				startOffset: r.startOffset,
				endContainer: r.endContainer,
				endOffset: r.endOffset
			};
		}
	}
	return { scrolls, activeEl, sel: snap };
}

function selectionMatches(sel: Selection, s: SelSnapshot): boolean {
	if (sel.rangeCount !== 1) return false;
	const r = sel.getRangeAt(0);
	return (
		r.startContainer === s.startContainer &&
		r.startOffset === s.startOffset &&
		r.endContainer === s.endContainer &&
		r.endOffset === s.endOffset
	);
}

// Restore is IDEMPOTENT: state the move already preserved (moveBefore keeps
// focus + selection natively) is left untouched. Re-asserting an unchanged
// selection would fire synthetic `selectionchange`/`focus` events, and
// edit-driven listeners (keepCursorVisible's caret nudge) treat those as a real
// caret move — the deferred pointerup check then scrolls the caret (= the
// user's OLD editing spot) back into view, which reads as "드래그하면 예전
// 스크롤로 회귀".
function restoreDomState(node: HTMLElement, s: DragDomState): void {
	for (const { el, top, left } of s.scrolls) {
		if (!el.isConnected) continue;
		el.scrollTop = top;
		el.scrollLeft = left;
	}
	// preventScroll is load-bearing: a plain focus() would scroll an ancestor to
	// reveal the caret and re-introduce the very jump we're preventing.
	if (
		s.activeEl &&
		s.activeEl.isConnected &&
		node.contains(s.activeEl) &&
		document.activeElement !== s.activeEl
	) {
		s.activeEl.focus({ preventScroll: true });
	}
	// Only re-apply the caret if its endpoints are still in the (live) DOM — a
	// debounced editor save could have rebuilt the ProseMirror DOM in between.
	if (s.sel && s.sel.startContainer.isConnected && s.sel.endContainer.isConnected) {
		const sel = window.getSelection();
		if (sel && !selectionMatches(sel, s.sel)) {
			try {
				const r = document.createRange();
				r.setStart(s.sel.startContainer, s.sel.startOffset);
				r.setEnd(s.sel.endContainer, s.sel.endOffset);
				sel.removeAllRanges();
				sel.addRange(r);
			} catch {
				// Offsets no longer valid (content mutated mid-drag) — keep whatever
				// selection the browser left rather than throwing mid-drop.
			}
		}
	}
}

// Move `node` to before `ref` (null = append) inside `parent`, preserving the
// subtree's scroll positions + focus/caret across the move.
//
// We snapshot+restore UNCONDITIONALLY — even when `moveBefore` is used. Reason:
// `moveBefore` (Chrome 133+) preserves focus / iframe / media / CSS-animation
// state, but does NOT preserve scrollTop/scrollLeft of scrollable descendants
// (undocumented and empirically lost — the reparent still reclamps scroll on the
// new parent's layout). So we still relocate the embedded 묶음/탭 `.bundle-body`
// to the top without the explicit restore. `moveBefore` is preferred when
// present (its focus/media preservation is strictly better than the plain
// fallback), but the scroll restore is what actually kills the "드래그하면 번들
// 스크롤 맨 위로" bug — hence it wraps BOTH paths. Restoring focus/caret too is
// belt-and-suspenders: if moveBefore already kept them, re-applying the same
// range is a no-op; on the plain fallback it's the only thing that keeps them.
function atomicMove(parent: Node, node: HTMLElement, ref: Node | null): void {
	const snap = captureDomState(node);
	const p = parent as Node & { moveBefore?: (n: Node, r: Node | null) => void };
	let moved = false;
	if (
		typeof p.moveBefore === 'function' &&
		node.isConnected &&
		node.getRootNode() === parent.getRootNode()
	) {
		try {
			p.moveBefore(node, ref);
			moved = true;
		} catch {
			// Some invalid-state cases throw — fall through to the plain move.
		}
	}
	if (!moved) {
		if (ref) parent.insertBefore(node, ref);
		else parent.appendChild(node);
	}
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
