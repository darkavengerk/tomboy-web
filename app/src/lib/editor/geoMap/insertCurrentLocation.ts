/**
 * Read the user's current GPS coordinates via the browser Geolocation API
 * and insert them at the editor cursor as a `geo:lat,lon` text wrapped in
 * the `tomboyUrlLink` mark.
 *
 * On any failure, surfaces a Korean toast via the existing toast store and
 * leaves the editor doc untouched.
 */

import type { Editor } from '@tiptap/core';
import { pushToast } from '$lib/stores/toast.js';

const TIMEOUT_MS = 10_000;

function getCurrentPositionAsync(): Promise<GeolocationPosition> {
	return new Promise((resolve, reject) => {
		if (typeof navigator === 'undefined' || !navigator.geolocation) {
			reject({ code: 2, message: 'geolocation unavailable' });
			return;
		}
		navigator.geolocation.getCurrentPosition(resolve, reject, {
			enableHighAccuracy: true,
			timeout: TIMEOUT_MS
		});
	});
}

function toastForError(err: { code?: number }): void {
	switch (err.code) {
		case 1:
			pushToast(
				'위치 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.',
				{ kind: 'error' }
			);
			return;
		case 3:
			pushToast('위치 가져오기 시간 초과', { kind: 'error' });
			return;
		case 2:
		default:
			pushToast('현재 위치를 가져올 수 없습니다.', { kind: 'error' });
	}
}

export async function insertCurrentLocation(editor: Editor): Promise<void> {
	let pos: GeolocationPosition;
	try {
		pos = await getCurrentPositionAsync();
	} catch (err) {
		toastForError(err as { code?: number });
		return;
	}
	const lat = pos.coords.latitude.toFixed(6);
	const lon = pos.coords.longitude.toFixed(6);
	const text = `geo:${lat},${lon}`;
	editor
		.chain()
		.focus()
		.insertContent({
			type: 'text',
			text,
			marks: [{ type: 'tomboyUrlLink', attrs: { href: text } }]
		})
		.unsetMark('tomboyUrlLink')
		.run();
}
