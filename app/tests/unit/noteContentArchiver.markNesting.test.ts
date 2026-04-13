import { describe, it, expect } from 'vitest';
import {
	serializeContent,
	deserializeContent
} from '$lib/core/noteContentArchiver.js';

/**
 * When a text run carries two or more marks, the OUTER/INNER nesting in the
 * emitted XML must match the source. Two chained mark elements whose middle
 * run shares both marks must round-trip as one continuous outer span, not as
 * alternating outer/inner combinations.
 */
describe('noteContentArchiver — nested mark ordering', () => {
	it('coalesces two adjacent <bold> runs with inner <strikethrough> into one outer <bold>, keeping nesting', () => {
		// Source (non-canonical): two adjacent <bold> runs, middle text has
		// inner strikethrough. Tomboy would coalesce same-name adjacent tags
		// into one continuous range; our canonical form does the same — but
		// must NOT flip the nesting to make strikethrough outer.
		const source =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<bold>호주: <strikethrough>강의 없으면 목록에서 제거해서 보내주기</strikethrough></bold>` +
			`<bold> 14일 전 구현</bold>` +
			`</list-item></list>` +
			`</note-content>`;
		const canonical = serializeContent(deserializeContent(source));
		expect(canonical).toContain(
			'<bold>호주: <strikethrough>강의 없으면 목록에서 제거해서 보내주기</strikethrough> 14일 전 구현</bold>'
		);
		expect(canonical).not.toContain('<strikethrough><bold>');
		// And must be a fixed point (idempotent).
		const twice = serializeContent(deserializeContent(canonical));
		expect(twice).toBe(canonical);
	});

	it('coalesces strikethrough over an internal link and preserves strikethrough as the outer span', () => {
		const source =
			`<note-content version="0.1">T\n` +
			`<list><list-item dir="ltr">` +
			`<strikethrough>화실에서 <link:internal>보드게임</link:internal></strikethrough>` +
			`<strikethrough> 가져오기</strikethrough>` +
			`</list-item></list>` +
			`</note-content>`;
		const canonical = serializeContent(deserializeContent(source));
		expect(canonical).toContain(
			'<strikethrough>화실에서 <link:internal>보드게임</link:internal> 가져오기</strikethrough>'
		);
		expect(canonical).not.toContain('<link:internal><strikethrough>');
		const twice = serializeContent(deserializeContent(canonical));
		expect(twice).toBe(canonical);
	});
});
