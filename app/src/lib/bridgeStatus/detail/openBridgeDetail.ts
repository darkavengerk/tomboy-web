import { mount, unmount } from 'svelte';
import BridgeDetailOverlay from './BridgeDetailOverlay.svelte';

let current: Record<string, unknown> | null = null;
let host: HTMLElement | null = null;

/** 서비스 상세 오버레이를 body 에 1개만 띄운다(읽기전용, 닫으면 정리). */
export function openBridgeDetail(serviceKey: string): void {
	if (current) return;
	host = document.createElement('div');
	document.body.appendChild(host);
	const close = () => {
		if (current) {
			unmount(current);
			current = null;
		}
		host?.remove();
		host = null;
	};
	current = mount(BridgeDetailOverlay, { target: host, props: { serviceKey, onclose: close } });
}
