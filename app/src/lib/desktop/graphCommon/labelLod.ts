export interface LabelEntry {
	node: { x?: number; y?: number; z?: number };
	label: { visible: boolean; material: { opacity: number; transparent: boolean } };
	isHub: boolean;
}

/**
 * Distance-based label opacity update.
 *
 * isHub=true entries are skipped entirely (always-on labels — hubs and
 * categories own their own visibility/opacity once at creation time).
 *
 * For others:
 *   d ≤ baseDistance          → opacity 1, visible
 *   baseDistance < d < 2×base → linear fade: opacity = (2*base - d) / base
 *   d ≥ 2×baseDistance        → visible = false
 *
 * Hot-path comparisons use squared distance to avoid sqrt; sqrt is only
 * called inside the fade band to derive the actual opacity. Visibility/
 * opacity writes are guarded so they only happen on change — this runs
 * every RAF frame across thousands of entries.
 */
export function updateLabelOpacity(
	entries: LabelEntry[],
	camX: number,
	camY: number,
	camZ: number,
	baseDistance: number
): void {
	const baseSq = baseDistance * baseDistance;
	const fadeEndSq = 4 * baseSq;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.isHub) continue;
		const n = entry.node;
		if (n.x === undefined) continue;
		const dx = camX - n.x;
		const dy = camY - (n.y ?? 0);
		const dz = camZ - (n.z ?? 0);
		const d2 = dx * dx + dy * dy + dz * dz;
		const mat = entry.label.material;
		if (d2 >= fadeEndSq) {
			if (entry.label.visible) entry.label.visible = false;
			continue;
		}
		if (!entry.label.visible) entry.label.visible = true;
		if (d2 <= baseSq) {
			if (mat.opacity !== 1) mat.opacity = 1;
		} else {
			const d = Math.sqrt(d2);
			mat.opacity = (2 * baseDistance - d) / baseDistance;
		}
	}
}
