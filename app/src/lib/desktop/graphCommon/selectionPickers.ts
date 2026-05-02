import type * as THREE from 'three';

export interface PickerNode {
	id: string;
	x?: number;
	y?: number;
	z?: number;
}

export interface PickerOptions<N extends PickerNode> {
	filter?: (n: N) => boolean;
}

export const CENTER_PICK_RADIUS_PX = 50;

export const AIM_OFFSET = 40;

export interface CenterPickerScratch {
	ndc: THREE.Vector3;
}

export interface AimedPickerScratch {
	forward: THREE.Vector3;
	tmpPoint: THREE.Vector3;
	frustum: THREE.Frustum;
	projMatrix: THREE.Matrix4;
}

/**
 * Pick the node closest to screen center within CENTER_PICK_RADIUS_PX.
 * Among candidates within the screen-space radius, the one closest to the
 * reticle (smallest pixel distance) wins — depth is intentionally ignored
 * so small distant nodes aren't lost to larger off-axis ones.
 */
export function findCenterNode<N extends PickerNode>(
	nodes: readonly N[],
	camera: THREE.Camera,
	rendererSize: { width: number; height: number },
	scratch: CenterPickerScratch,
	opts?: PickerOptions<N>
): string | null {
	camera.updateMatrixWorld();
	const halfW = rendererSize.width / 2;
	const halfH = rendererSize.height / 2;
	const threshSq = CENTER_PICK_RADIUS_PX * CENTER_PICK_RADIUS_PX;
	const filter = opts?.filter;

	let bestId: string | null = null;
	let bestDistSq = Infinity;
	for (const n of nodes) {
		if (filter && !filter(n)) continue;
		if (n.x === undefined) continue;
		scratch.ndc.set(n.x, n.y ?? 0, n.z ?? 0);
		scratch.ndc.project(camera);
		if (scratch.ndc.z < -1 || scratch.ndc.z > 1) continue;
		const px = scratch.ndc.x * halfW;
		const py = scratch.ndc.y * halfH;
		const dSq = px * px + py * py;
		if (dSq <= threshSq && dSq < bestDistSq) {
			bestDistSq = dSq;
			bestId = n.id;
		}
	}
	return bestId;
}

/**
 * Pick the frustum-visible node closest to the camera's "aim point" — a
 * point AIM_OFFSET units along the camera's forward direction. Returns
 * null when the frustum is empty so callers can hold the previous
 * selection while the user stares into empty space.
 */
export function findAimedNode<N extends PickerNode>(
	nodes: readonly N[],
	camera: THREE.Camera,
	scratch: AimedPickerScratch,
	opts?: PickerOptions<N>
): string | null {
	camera.updateMatrixWorld();
	scratch.projMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	scratch.frustum.setFromProjectionMatrix(scratch.projMatrix);
	camera.getWorldDirection(scratch.forward);

	const ax = camera.position.x + scratch.forward.x * AIM_OFFSET;
	const ay = camera.position.y + scratch.forward.y * AIM_OFFSET;
	const az = camera.position.z + scratch.forward.z * AIM_OFFSET;
	const filter = opts?.filter;

	let bestId: string | null = null;
	let bestD2 = Infinity;
	for (const n of nodes) {
		if (filter && !filter(n)) continue;
		if (n.x === undefined) continue;
		scratch.tmpPoint.set(n.x, n.y ?? 0, n.z ?? 0);
		if (!scratch.frustum.containsPoint(scratch.tmpPoint)) continue;
		const dx = ax - scratch.tmpPoint.x;
		const dy = ay - scratch.tmpPoint.y;
		const dz = az - scratch.tmpPoint.z;
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 < bestD2) {
			bestD2 = d2;
			bestId = n.id;
		}
	}
	return bestId;
}
