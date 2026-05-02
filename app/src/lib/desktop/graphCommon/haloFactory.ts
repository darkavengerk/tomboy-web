import * as THREE from 'three';

export const PULSE_DURATION_MS = 420;
export const HALO_INNER_RADIUS = 1;
export const HALO_OUTER_RADIUS = 1.08;

export interface HaloHandle {
	mesh: THREE.Mesh;
	/**
	 * Dispose the geometry and material. Caller is responsible for
	 * removing `mesh` from its scene before/after calling this.
	 * Both routes use a single static halo per role for the lifetime
	 * of the page, so dispose is only invoked on unmount.
	 */
	dispose: () => void;
}

/**
 * Cyan billboard ring for the currently-selected node. Caller positions,
 * scales, billboards (lookAt), and toggles visibility per frame.
 */
export function createSelectionHalo(): HaloHandle {
	const geometry = new THREE.RingGeometry(HALO_INNER_RADIUS, HALO_OUTER_RADIUS, 64);
	const material = new THREE.MeshBasicMaterial({
		color: 0x5ad6ff,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.55,
		depthWrite: false
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.visible = false;
	mesh.renderOrder = 999;
	return {
		mesh,
		dispose() {
			geometry.dispose();
			material.dispose();
		}
	};
}

/**
 * Translucent white ring marking the hover/center node. Lower segment
 * count (48 vs 64) since it's a more transient marker — the eye doesn't
 * dwell on it long enough to notice the polygonization.
 */
export function createHoverHalo(): HaloHandle {
	const geometry = new THREE.RingGeometry(HALO_INNER_RADIUS, HALO_OUTER_RADIUS, 48);
	const material = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.22,
		depthWrite: false
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.visible = false;
	mesh.renderOrder = 998;
	return {
		mesh,
		dispose() {
			geometry.dispose();
			material.dispose();
		}
	};
}

/**
 * Apply pulse-scale to a halo's `mesh.scale`.
 *
 * If `now >= pulseUntil`, scales the mesh to `baseRadius` (no pulse).
 * Otherwise, scales to `baseRadius * (1 + remaining * 0.45)` where
 * `remaining = (pulseUntil - now) / PULSE_DURATION_MS` (1 at click, 0 at end).
 */
export function applyPulse(
	mesh: THREE.Mesh,
	baseRadius: number,
	now: number,
	pulseUntil: number
): void {
	let pulse = 1;
	if (now < pulseUntil) {
		const remaining = (pulseUntil - now) / PULSE_DURATION_MS;
		pulse = 1 + remaining * 0.45;
	}
	mesh.scale.setScalar(baseRadius * pulse);
}
