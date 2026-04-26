import { describe, it, expect } from 'vitest';
import { shouldSendListBeActive } from '$lib/editor/sendListItem/sendActiveGate.js';

const SOURCE = 'd5ef5481-b301-44fa-bd50-aa5ce7b32cf2';
const OTHER = 'aaaaaaaa-0000-0000-0000-000000000000';

describe('shouldSendListBeActive', () => {
	it('desktop, all conditions true → true', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: true,
				focusedGuid: SOURCE
			})
		).toBe(true);
	});

	it('desktop, ctrl false → false', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: false,
				focusedGuid: SOURCE
			})
		).toBe(false);
	});

	it('desktop, focusedGuid mismatched → false', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: true,
				focusedGuid: OTHER
			})
		).toBe(false);
	});

	it('desktop, focusedGuid null → false', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: true,
				focusedGuid: null
			})
		).toBe(false);
	});

	it('wrong source guid → false', () => {
		expect(
			shouldSendListBeActive({
				guid: OTHER,
				sourceGuid: SOURCE,
				ctrlHeld: true,
				focusedGuid: OTHER
			})
		).toBe(false);
	});

	it('mobile (ignoreFocus: true), focusedGuid null but other conditions true → true', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: true,
				focusedGuid: null,
				ignoreFocus: true
			})
		).toBe(true);
	});

	it('mobile, ctrl false → false', () => {
		expect(
			shouldSendListBeActive({
				guid: SOURCE,
				sourceGuid: SOURCE,
				ctrlHeld: false,
				focusedGuid: null,
				ignoreFocus: true
			})
		).toBe(false);
	});
});
