/**
 * Parse a `geo:lat,lon[;...]` URI (RFC 5870 basic form).
 *
 * v1 ignores optional parameters (`;u=`, `;z=`, `;crs=`, etc) — the parser
 * accepts them silently but extracts only lat/lon. This leaves the encoding
 * stable for future extensions (e.g. storing zoom as `;z=15`).
 *
 * Returns `null` for any malformed input or coordinates outside the
 * lat ∈ [-90, 90] / lon ∈ [-180, 180] range.
 */

export interface GeoCoords {
	lat: number;
	lon: number;
}

// Scheme pinned to lowercase: the insertion helper emits lowercase `geo:`,
// and mixed-case would be a typo, not a valid link.
const GEO_RE = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(;.*)?$/;

export function parseGeoUrl(input: string): GeoCoords | null {
	if (!input) return null;
	const m = GEO_RE.exec(input);
	if (!m) return null;
	const lat = Number(m[1]);
	const lon = Number(m[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (lat < -90 || lat > 90) return null;
	if (lon < -180 || lon > 180) return null;
	return { lat, lon };
}
