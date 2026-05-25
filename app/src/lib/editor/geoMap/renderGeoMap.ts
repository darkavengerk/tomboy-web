/**
 * Lazy Leaflet loader + mount/destroy helper.
 *
 * Why lazy: Leaflet (~42KB gz) + CSS + marker icons should only land in the
 * user's browser if they actually have a geo: link in some note. The loader
 * is a module-level singleton promise — N concurrent widget renders trigger
 * exactly one network round-trip.
 *
 * Why icon-path mergeOptions: Leaflet's default Icon resolves marker images
 * via `L.Icon.Default.imagePath` which assumes a specific directory layout.
 * In Vite + adapter-static builds the assets land at hashed paths under
 * `_app/immutable/assets/`, so we import the PNGs explicitly and inject
 * them via `mergeOptions`. Without this, all markers render as broken-image
 * boxes in production builds.
 */

import type * as LeafletNS from 'leaflet';

export interface GeoMapInstance {
	destroy(): void;
}

let leafletPromise: Promise<typeof LeafletNS> | null = null;
let cssInjected = false;

function injectLeafletCss(): void {
	if (cssInjected) return;
	cssInjected = true;
	if (typeof document === 'undefined') return;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = new URL('leaflet/dist/leaflet.css', import.meta.url).href;
	document.head.appendChild(link);
}

export function loadLeaflet(): Promise<typeof LeafletNS> {
	if (!leafletPromise) {
		leafletPromise = (async () => {
			injectLeafletCss();
			const [L, iconUrl, iconRetinaUrl, shadowUrl] = await Promise.all([
				import('leaflet'),
				import('leaflet/dist/images/marker-icon.png').then((m) => m.default),
				import('leaflet/dist/images/marker-icon-2x.png').then((m) => m.default),
				import('leaflet/dist/images/marker-shadow.png').then((m) => m.default)
			]);
			// Remove the broken default-url resolver, then inject bundled ones.
			delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })
				._getIconUrl;
			L.Icon.Default.mergeOptions({
				iconUrl: iconUrl as string,
				iconRetinaUrl: iconRetinaUrl as string,
				shadowUrl: shadowUrl as string
			});
			return L;
		})();
	}
	return leafletPromise;
}

/**
 * Mount a Leaflet map into the given container with a single marker at
 * `coords`. Returns an instance whose `destroy()` tears the map down.
 *
 * Leaflet is loaded lazily on first call. While loading, the container
 * shows the placeholder text written into it by the caller (see plugin).
 */
export async function mountGeoMap(
	container: HTMLElement,
	coords: { lat: number; lon: number }
): Promise<GeoMapInstance> {
	const L = await loadLeaflet();
	// Clear any placeholder content the caller put in.
	container.textContent = '';
	const map = L.map(container, {
		center: [coords.lat, coords.lon],
		zoom: 15,
		zoomControl: true
	});
	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
	}).addTo(map);
	L.marker([coords.lat, coords.lon])
		.addTo(map)
		.bindPopup(`${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)}`);
	return {
		destroy() {
			map.remove();
		}
	};
}

/** Test-only: reset the module-level lazy promise between tests. */
export function _resetForTest(): void {
	leafletPromise = null;
	cssInjected = false;
}
