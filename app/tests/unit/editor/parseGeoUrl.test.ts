import { describe, it, expect } from 'vitest';
import { parseGeoUrl } from '$lib/editor/geoMap/parseGeoUrl.js';

describe('parseGeoUrl', () => {
	it('parses basic geo:lat,lon', () => {
		expect(parseGeoUrl('geo:37.123456,127.123456')).toEqual({
			lat: 37.123456,
			lon: 127.123456
		});
	});

	it('parses negative coordinates', () => {
		expect(parseGeoUrl('geo:-37.5,-127.5')).toEqual({
			lat: -37.5,
			lon: -127.5
		});
	});

	it('parses integer coordinates', () => {
		expect(parseGeoUrl('geo:37,127')).toEqual({ lat: 37, lon: 127 });
	});

	it('parses zero coordinates', () => {
		expect(parseGeoUrl('geo:0,0')).toEqual({ lat: 0, lon: 0 });
	});

	it('ignores optional RFC 5870 parameters', () => {
		expect(parseGeoUrl('geo:37.5,127.5;u=10')).toEqual({
			lat: 37.5,
			lon: 127.5
		});
		expect(parseGeoUrl('geo:37.5,127.5;z=15;crs=wgs84')).toEqual({
			lat: 37.5,
			lon: 127.5
		});
	});

	it('returns null for latitude out of range', () => {
		expect(parseGeoUrl('geo:91,0')).toBeNull();
		expect(parseGeoUrl('geo:-91,0')).toBeNull();
	});

	it('returns null for longitude out of range', () => {
		expect(parseGeoUrl('geo:0,181')).toBeNull();
		expect(parseGeoUrl('geo:0,-181')).toBeNull();
	});

	it('returns null for boundaries off by epsilon', () => {
		expect(parseGeoUrl('geo:90.0001,0')).toBeNull();
	});

	it('accepts exact boundary values', () => {
		expect(parseGeoUrl('geo:90,180')).toEqual({ lat: 90, lon: 180 });
		expect(parseGeoUrl('geo:-90,-180')).toEqual({ lat: -90, lon: -180 });
	});

	it('returns null for malformed strings', () => {
		expect(parseGeoUrl('geo:abc,def')).toBeNull();
		expect(parseGeoUrl('geo:')).toBeNull();
		expect(parseGeoUrl('geo:1')).toBeNull();
		expect(parseGeoUrl('geo:,')).toBeNull();
		expect(parseGeoUrl('')).toBeNull();
		expect(parseGeoUrl('geo:1,2,3')).toBeNull();
	});

	it('returns null without geo: prefix', () => {
		expect(parseGeoUrl('37.5,127.5')).toBeNull();
		expect(parseGeoUrl('https://example.com')).toBeNull();
	});

	it('is case-sensitive on the scheme (lowercase geo:)', () => {
		expect(parseGeoUrl('GEO:37.5,127.5')).toBeNull();
		expect(parseGeoUrl('Geo:37.5,127.5')).toBeNull();
	});
});
