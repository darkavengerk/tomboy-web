import { describe, it, expect } from 'vitest';
import {
	findTitleMatches,
	type TitleEntry
} from '$lib/editor/autoLink/findTitleMatches.js';

function t(title: string, guid = `guid-${title}`): TitleEntry {
	return { title, guid };
}

describe('findTitleMatches — trivial inputs', () => {
	it('returns empty array when titles is empty', () => {
		expect(findTitleMatches('any text here', [])).toEqual([]);
	});

	it('returns empty array when text is empty', () => {
		expect(findTitleMatches('', [t('Foo')])).toEqual([]);
	});

	it('ignores titles that are only whitespace', () => {
		expect(findTitleMatches('hello there', [t('   ')])).toEqual([]);
	});
});

describe('findTitleMatches — basic positions', () => {
	it('matches a title at the start of text', () => {
		const m = findTitleMatches('Foo bar baz', [t('Foo')]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ from: 0, to: 3, target: 'Foo' });
	});

	it('matches a title in the middle of text', () => {
		const m = findTitleMatches('see Foo today', [t('Foo')]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ from: 4, to: 7, target: 'Foo' });
	});

	it('matches a title at the end of text', () => {
		const m = findTitleMatches('it was Foo', [t('Foo')]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ from: 7, to: 10, target: 'Foo' });
	});
});

describe('findTitleMatches — word boundaries (ASCII)', () => {
	it('does not match inside a larger word — suffix', () => {
		expect(findTitleMatches('Foobar', [t('Foo')])).toEqual([]);
	});

	it('does not match inside a larger word — prefix', () => {
		expect(findTitleMatches('barFoo', [t('Foo')])).toEqual([]);
	});

	it('matches when surrounded by punctuation', () => {
		const m = findTitleMatches('...Foo!', [t('Foo')]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ from: 3, to: 6 });
	});

	it('does not match across an underscore boundary', () => {
		// underscore counts as a word char → Foo_bar means Foo is not a word on its own
		expect(findTitleMatches('Foo_bar', [t('Foo')])).toEqual([]);
	});
});

describe('findTitleMatches — word boundaries (CJK)', () => {
	it('matches a Korean title surrounded by spaces', () => {
		const m = findTitleMatches('나는 서울 에 산다', [t('서울')]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('서울');
	});

	it('does not match a Korean title inside a larger Korean word', () => {
		// "서울시" contains "서울" but boundary fails on right side
		expect(findTitleMatches('서울시에 간다', [t('서울')])).toEqual([]);
	});

	it('matches a CJK title adjacent to ASCII punctuation', () => {
		const m = findTitleMatches('(서울).', [t('서울')]);
		expect(m).toHaveLength(1);
	});
});

describe('findTitleMatches — longest-match priority', () => {
	it('prefers a longer title when a shorter overlapping one exists', () => {
		const m = findTitleMatches('I like Foo Bar today', [t('Foo'), t('Foo Bar')]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('Foo Bar');
		expect(m[0].from).toBe(7);
		expect(m[0].to).toBe(14);
	});

	it('still matches the shorter title when the longer one is absent', () => {
		const m = findTitleMatches('I like Foo today', [t('Foo'), t('Foo Bar')]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('Foo');
	});
});

describe('findTitleMatches — case sensitivity', () => {
	it('matches exact case only — does NOT link uppercase text to a mixed-case title', () => {
		expect(findTitleMatches('FOO HERE', [t('Foo')])).toEqual([]);
	});

	it('does NOT link when only case differs', () => {
		expect(findTitleMatches('Hello world', [t('HELLO')])).toEqual([]);
	});

	it('matches a title whose case matches the text exactly', () => {
		const m = findTitleMatches('Hello world', [t('Hello')]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('Hello');
	});

	it('treats differently-cased titles as distinct entries (both can match)', () => {
		// Uniqueness invariant still allows "Foo" and "foo" to coexist —
		// only exact-case text gets the link for each.
		const m = findTitleMatches('Foo and foo', [t('Foo', 'a'), t('foo', 'b')]);
		expect(m).toHaveLength(2);
		const byTarget = Object.fromEntries(m.map((x) => [x.target, x]));
		expect(byTarget.Foo?.guid).toBe('a');
		expect(byTarget.foo?.guid).toBe('b');
	});
});

describe('findTitleMatches — regex-special characters', () => {
	it('treats title as literal, not regex', () => {
		const m = findTitleMatches('use a.b(c)* here', [t('a.b(c)*')]);
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('a.b(c)*');
	});

	it('does not match regex pattern when title has "." literal', () => {
		// title "a.b" should match "a.b" but NOT "aXb"
		expect(findTitleMatches('aXb here', [t('a.b')])).toEqual([]);
	});
});

describe('findTitleMatches — exclusion', () => {
	it('excludes the title whose guid matches excludeGuid', () => {
		const entry = t('Self', 'self-guid');
		expect(findTitleMatches('Self is here', [entry], { excludeGuid: 'self-guid' })).toEqual([]);
	});

	it('still matches a different title when excludeGuid is set', () => {
		const self = t('Self', 'self-guid');
		const other = t('Other', 'other-guid');
		const m = findTitleMatches('Self and Other', [self, other], { excludeGuid: 'self-guid' });
		expect(m).toHaveLength(1);
		expect(m[0].target).toBe('Other');
	});
});

describe('findTitleMatches — multiple non-overlapping matches', () => {
	it('matches two different titles in one text', () => {
		const m = findTitleMatches('Foo and Bar together', [t('Foo'), t('Bar')]);
		expect(m).toHaveLength(2);
		const targets = m.map((x) => x.target).sort();
		expect(targets).toEqual(['Bar', 'Foo']);
	});

	it('matches the same title multiple times', () => {
		const m = findTitleMatches('Foo and Foo again', [t('Foo')]);
		expect(m).toHaveLength(2);
	});

	it('does not produce overlapping matches', () => {
		// "Foo Bar Foo" with title "Foo" → two matches, at 0..3 and 8..11
		const m = findTitleMatches('Foo Bar Foo', [t('Foo')]);
		expect(m).toHaveLength(2);
		expect(m[0].to).toBeLessThanOrEqual(m[1].from);
	});
});
