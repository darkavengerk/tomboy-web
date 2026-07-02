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

export function dragLift(node: HTMLElement, params: DragLiftParams) {
	let placeholder: Comment | null = null;
	let isLifted = false;

	function lift(target: HTMLElement | string | undefined): void {
		if (isLifted) return;
		const dest = resolveTarget(target);
		if (!dest) return;
		placeholder = document.createComment('drag-lift');
		node.parentNode?.insertBefore(placeholder, node);
		dest.appendChild(node);
		isLifted = true;
	}

	function drop(): void {
		if (!isLifted) return;
		if (placeholder?.parentNode) {
			placeholder.parentNode.insertBefore(node, placeholder);
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
