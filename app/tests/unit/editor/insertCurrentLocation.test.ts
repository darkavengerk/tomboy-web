import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TomboyUrlLink } from '$lib/editor/extensions/TomboyUrlLink.js';
import { insertCurrentLocation } from '$lib/editor/geoMap/insertCurrentLocation.js';
import { toasts, _resetForTest } from '$lib/stores/toast.js';
import { get } from 'svelte/store';

let currentEditor: Editor | null = null;

function makeEditor(): Editor {
	const editor = new Editor({
		extensions: [Document, Paragraph, Text, TomboyUrlLink],
		content: '<p></p>'
	});
	currentEditor = editor;
	return editor;
}

function mockGeolocation(impl: Partial<Geolocation>) {
	Object.defineProperty(globalThis.navigator, 'geolocation', {
		value: impl,
		configurable: true
	});
}

function lastToastMessage(): string | null {
	const list = get(toasts);
	return list.length ? list[list.length - 1].message : null;
}

beforeEach(() => {
	_resetForTest();
});

afterEach(() => {
	currentEditor?.destroy();
	currentEditor = null;
});

describe('insertCurrentLocation', () => {
	it('inserts geo:lat,lon with 6-decimal precision wrapped in tomboyUrlLink mark', async () => {
		const editor = makeEditor();
		mockGeolocation({
			getCurrentPosition(success) {
				success({
					coords: {
						latitude: 37.1234567,
						longitude: 127.7654321,
						accuracy: 10,
						altitude: null,
						altitudeAccuracy: null,
						heading: null,
						speed: null,
						toJSON() { return {}; }
					},
					timestamp: Date.now(),
					toJSON() { return {}; }
				} as GeolocationPosition);
			}
		});
		await insertCurrentLocation(editor);
		const text = editor.state.doc.textContent;
		expect(text).toBe('geo:37.123457,127.765432');

		let foundMark = false;
		editor.state.doc.descendants((node) => {
			if (!node.isText) return;
			if (node.marks.some((m) => m.type.name === 'tomboyUrlLink')) {
				foundMark = true;
			}
		});
		expect(foundMark).toBe(true);
	});

	it('toasts permission-denied message and does not insert', async () => {
		const editor = makeEditor();
		mockGeolocation({
			getCurrentPosition(_success, error) {
				error?.({
					code: 1,
					message: 'denied',
					PERMISSION_DENIED: 1,
					POSITION_UNAVAILABLE: 2,
					TIMEOUT: 3
				} as GeolocationPositionError);
			}
		});
		await insertCurrentLocation(editor);
		expect(editor.state.doc.textContent).toBe('');
		expect(lastToastMessage()).toContain('위치 권한이 거부');
	});

	it('toasts unavailable message', async () => {
		const editor = makeEditor();
		mockGeolocation({
			getCurrentPosition(_success, error) {
				error?.({
					code: 2,
					message: 'unavail',
					PERMISSION_DENIED: 1,
					POSITION_UNAVAILABLE: 2,
					TIMEOUT: 3
				} as GeolocationPositionError);
			}
		});
		await insertCurrentLocation(editor);
		expect(lastToastMessage()).toContain('가져올 수 없습니다');
	});

	it('toasts timeout message', async () => {
		const editor = makeEditor();
		mockGeolocation({
			getCurrentPosition(_success, error) {
				error?.({
					code: 3,
					message: 'timeout',
					PERMISSION_DENIED: 1,
					POSITION_UNAVAILABLE: 2,
					TIMEOUT: 3
				} as GeolocationPositionError);
			}
		});
		await insertCurrentLocation(editor);
		expect(lastToastMessage()).toContain('시간 초과');
	});

	it('handles missing navigator.geolocation', async () => {
		const editor = makeEditor();
		Object.defineProperty(globalThis.navigator, 'geolocation', {
			value: undefined,
			configurable: true
		});
		await insertCurrentLocation(editor);
		expect(editor.state.doc.textContent).toBe('');
		expect(lastToastMessage()).toContain('가져올 수 없습니다');
	});

	it('passes enableHighAccuracy and timeout options', async () => {
		const editor = makeEditor();
		const spy = vi.fn();
		mockGeolocation({
			getCurrentPosition: spy
		});
		void insertCurrentLocation(editor);
		expect(spy).toHaveBeenCalledTimes(1);
		const opts = spy.mock.calls[0][2];
		expect(opts).toEqual(
			expect.objectContaining({ enableHighAccuracy: true, timeout: 10000 })
		);
	});
});
