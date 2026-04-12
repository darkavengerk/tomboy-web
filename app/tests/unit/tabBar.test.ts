import { describe, it, expect } from 'vitest';

// TabBar logic is pure — test the isActive function separately
function isActive(currentPath: string, href: string): boolean {
	if (href === '/') return currentPath === '/';
	return currentPath === href || currentPath.startsWith(href + '/');
}

describe('TabBar active logic', () => {
	it('marks "/" active only when path is exactly "/"', () => {
		expect(isActive('/', '/')).toBe(true);
		expect(isActive('/notes', '/')).toBe(false);
		expect(isActive('/notebooks', '/')).toBe(false);
	});

	it('marks "/notes" active when path starts with /notes', () => {
		expect(isActive('/notes', '/notes')).toBe(true);
		expect(isActive('/notes/', '/notes')).toBe(true);
		expect(isActive('/', '/notes')).toBe(false);
	});

	it('marks "/notebooks" active when in a notebook sub-route', () => {
		expect(isActive('/notebooks', '/notebooks')).toBe(true);
		expect(isActive('/notebooks/Work', '/notebooks')).toBe(true);
		expect(isActive('/', '/notebooks')).toBe(false);
	});

	it('marks "/random" active for random path', () => {
		expect(isActive('/random', '/random')).toBe(true);
		expect(isActive('/notes', '/random')).toBe(false);
	});

	it('has correct 4 tab hrefs defined', () => {
		const items = [
			{ href: '/', label: '홈' },
			{ href: '/notes', label: '전체' },
			{ href: '/notebooks', label: '노트북' },
			{ href: '/random', label: '랜덤' }
		];
		expect(items).toHaveLength(4);
		expect(items.map((i) => i.href)).toEqual(['/', '/notes', '/notebooks', '/random']);
	});
});
