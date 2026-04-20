// Svelte action: re-parents the node to document.body so its z-index is
// evaluated at the document root instead of inside an ancestor stacking
// context (e.g. a NoteWindow with its own z-index).
export function portal(node: HTMLElement, target: HTMLElement | string = document.body) {
	const targetEl = typeof target === 'string' ? document.querySelector(target) : target;
	if (!(targetEl instanceof HTMLElement)) return;
	targetEl.appendChild(node);
	return {
		destroy() {
			node.parentNode?.removeChild(node);
		}
	};
}
