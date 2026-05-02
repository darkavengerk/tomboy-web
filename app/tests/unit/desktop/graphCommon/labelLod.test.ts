import { describe, it, expect } from 'vitest';
import {
	updateLabelOpacity,
	type LabelEntry
} from '$lib/desktop/graphCommon/labelLod.js';

function makeEntry(
	x: number | undefined,
	y: number,
	z: number,
	isHub: boolean,
	visible = false,
	opacity = 0
): LabelEntry {
	return {
		node: { x, y, z },
		label: { visible, material: { opacity, transparent: !isHub } },
		isHub
	};
}

describe('updateLabelOpacity', () => {
	it('hub entries are left untouched regardless of distance', () => {
		// At camera position, but isHub=true → no change.
		const near = makeEntry(0, 0, 0, true, false, 0);
		// Far away, hub → still no change.
		const far = makeEntry(10000, 10000, 10000, true, false, 0);

		updateLabelOpacity([near, far], 0, 0, 0, 100);

		expect(near.label.visible).toBe(false);
		expect(near.label.material.opacity).toBe(0);
		expect(far.label.visible).toBe(false);
		expect(far.label.material.opacity).toBe(0);
	});

	it('d ≤ base → opacity 1, visible true', () => {
		// Camera and node both at origin → d = 0 ≤ base.
		const entry = makeEntry(0, 0, 0, false, false, 0);
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(true);
		expect(entry.label.material.opacity).toBe(1);
	});

	it('d ≥ 2×base → visible false', () => {
		// Distance = 200 = 2×base, so d² = fadeEndSq → hidden.
		const entry = makeEntry(200, 0, 0, false, true, 1);
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(false);
	});

	it('fade band is linear: d = 1.5×base → opacity 0.5', () => {
		// Distance 150, base 100 → opacity = (200 - 150) / 100 = 0.5.
		const entry = makeEntry(150, 0, 0, false, false, 0);
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(true);
		expect(entry.label.material.opacity).toBeCloseTo(0.5, 6);
	});

	it('node without x is skipped', () => {
		const entry: LabelEntry = {
			node: { y: 0, z: 0 },
			label: { visible: false, material: { opacity: 0, transparent: true } },
			isHub: false
		};
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(false);
		expect(entry.label.material.opacity).toBe(0);
	});

	it('fade band exactly at base boundary clamps to opacity 1', () => {
		// d = base exactly → d² = baseSq, falls in d² ≤ baseSq branch.
		const entry = makeEntry(100, 0, 0, false, false, 0);
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(true);
		expect(entry.label.material.opacity).toBe(1);
	});

	it('y and z default to 0 when omitted on the node', () => {
		const entry: LabelEntry = {
			node: { x: 0 },
			label: { visible: false, material: { opacity: 0, transparent: true } },
			isHub: false
		};
		// Camera at (0, 0, 0), node at (0, undefined→0, undefined→0) → d=0.
		updateLabelOpacity([entry], 0, 0, 0, 100);
		expect(entry.label.visible).toBe(true);
		expect(entry.label.material.opacity).toBe(1);
	});
});
