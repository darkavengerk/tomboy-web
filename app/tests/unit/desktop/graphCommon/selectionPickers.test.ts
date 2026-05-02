import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	findCenterNode,
	findAimedNode,
	CENTER_PICK_RADIUS_PX,
	AIM_OFFSET,
	type CenterPickerScratch,
	type AimedPickerScratch
} from '$lib/desktop/graphCommon/selectionPickers.js';

interface TestNode {
	id: string;
	x?: number;
	y?: number;
	z?: number;
	isCategory?: boolean;
}

function makeCenterScratch(): CenterPickerScratch {
	return { ndc: new THREE.Vector3() };
}

function makeAimedScratch(): AimedPickerScratch {
	return {
		forward: new THREE.Vector3(),
		tmpPoint: new THREE.Vector3(),
		frustum: new THREE.Frustum(),
		projMatrix: new THREE.Matrix4()
	};
}

function makeCamera(): THREE.PerspectiveCamera {
	const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
	cam.position.set(0, 0, 100);
	cam.lookAt(0, 0, 0);
	cam.updateMatrixWorld();
	return cam;
}

const RENDERER = { width: 800, height: 800 };

describe('findCenterNode', () => {
	it('respects the filter callback (categories excluded when filter says so)', () => {
		const camera = makeCamera();
		// Place a single node at world origin — directly under the reticle.
		const nodes: TestNode[] = [{ id: 'cat', x: 0, y: 0, z: 0, isCategory: true }];

		// Without filter: the on-axis node is picked (sanity check).
		const idAll = findCenterNode(nodes, camera, RENDERER, makeCenterScratch());
		expect(idAll).toBe('cat');

		// With a filter that excludes categories: nothing eligible → null.
		const idFiltered = findCenterNode(nodes, camera, RENDERER, makeCenterScratch(), {
			filter: (n) => !n.isCategory
		});
		expect(idFiltered).toBeNull();
	});

	it('returns null on an empty array', () => {
		const camera = makeCamera();
		expect(findCenterNode([], camera, RENDERER, makeCenterScratch())).toBeNull();
	});

	it('returns null when no candidate is within the pick radius', () => {
		const camera = makeCamera();
		// Push the node far off-axis on x so its projected pixel distance from
		// reticle is much greater than CENTER_PICK_RADIUS_PX.
		const nodes: TestNode[] = [{ id: 'far', x: 200, y: 0, z: 0 }];
		const id = findCenterNode(nodes, camera, RENDERER, makeCenterScratch());
		expect(id).toBeNull();
	});

	it('breaks ties by screen-space distance, not depth', () => {
		const camera = makeCamera();
		// Two nodes: 'on-axis' is exactly under the reticle; 'off-axis' is at
		// the same z but slightly off the x-axis, giving it nonzero pixel
		// distance from center. The on-axis one should win.
		const nodes: TestNode[] = [
			{ id: 'on-axis', x: 0, y: 0, z: 0 },
			{ id: 'off-axis', x: 1, y: 0, z: 50 }
		];
		const id = findCenterNode(nodes, camera, RENDERER, makeCenterScratch());
		expect(id).toBe('on-axis');
	});

	it('skips nodes with undefined x', () => {
		const camera = makeCamera();
		const nodes: TestNode[] = [
			{ id: 'no-pos' },
			{ id: 'on-axis', x: 0, y: 0, z: 0 }
		];
		const id = findCenterNode(nodes, camera, RENDERER, makeCenterScratch());
		expect(id).toBe('on-axis');
	});

	it('exposes CENTER_PICK_RADIUS_PX as 50', () => {
		expect(CENTER_PICK_RADIUS_PX).toBe(50);
	});
});

describe('findAimedNode', () => {
	it('respects the filter callback', () => {
		const camera = makeCamera();
		// Aim point with this camera (pos z=100, forward=-z) is at z = 60.
		const nodes: TestNode[] = [{ id: 'cat', x: 0, y: 0, z: 60, isCategory: true }];

		const idAll = findAimedNode(nodes, camera, makeAimedScratch());
		expect(idAll).toBe('cat');

		const idFiltered = findAimedNode(nodes, camera, makeAimedScratch(), {
			filter: (n) => !n.isCategory
		});
		expect(idFiltered).toBeNull();
	});

	it('returns null on an empty array', () => {
		const camera = makeCamera();
		expect(findAimedNode([], camera, makeAimedScratch())).toBeNull();
	});

	it('returns null when no node is inside the frustum', () => {
		const camera = makeCamera();
		// Behind the camera (z=200) — outside the view frustum.
		const nodes: TestNode[] = [{ id: 'behind', x: 0, y: 0, z: 200 }];
		expect(findAimedNode(nodes, camera, makeAimedScratch())).toBeNull();
	});

	it('returns the node closest to camera + forward * AIM_OFFSET', () => {
		const camera = makeCamera();
		// Aim point is at (0, 0, 100 - 40) = (0, 0, 60).
		// 'near-aim' is exactly at the aim point; 'far-aim' is on-axis but
		// far from it. Both inside frustum.
		const nodes: TestNode[] = [
			{ id: 'near-aim', x: 0, y: 0, z: 60 },
			{ id: 'far-aim', x: 0, y: 0, z: 0 }
		];
		const id = findAimedNode(nodes, camera, makeAimedScratch());
		expect(id).toBe('near-aim');
	});

	it('skips nodes with undefined x', () => {
		const camera = makeCamera();
		const nodes: TestNode[] = [
			{ id: 'no-pos' },
			{ id: 'visible', x: 0, y: 0, z: 60 }
		];
		const id = findAimedNode(nodes, camera, makeAimedScratch());
		expect(id).toBe('visible');
	});

	it('exposes AIM_OFFSET as 40', () => {
		expect(AIM_OFFSET).toBe(40);
	});
});
