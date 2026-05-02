import { describe, it, expect } from 'vitest';
import { normalizeRepoUrl, githubLink } from '$lib/codegraph/githubLink.js';

describe('normalizeRepoUrl', () => {
	it('SSH form with .git suffix → https://github.com/owner/repo', () => {
		expect(normalizeRepoUrl('git@github.com:darkavengerk/tomboy-web.git')).toBe(
			'https://github.com/darkavengerk/tomboy-web'
		);
	});

	it('HTTPS form with .git suffix is stripped', () => {
		expect(normalizeRepoUrl('https://github.com/darkavengerk/tomboy-web.git')).toBe(
			'https://github.com/darkavengerk/tomboy-web'
		);
	});

	it('already-normalized URL is idempotent', () => {
		const url = 'https://github.com/darkavengerk/tomboy-web';
		expect(normalizeRepoUrl(url)).toBe(url);
	});

	it('SSH form without .git is converted', () => {
		expect(normalizeRepoUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo');
	});
});

describe('githubLink', () => {
	const meta = { repoUrl: 'https://github.com/x/y', branch: 'main' };

	it('returns null when sourceFile is empty', () => {
		expect(githubLink(meta, '', 'L15')).toBeNull();
	});

	it('returns URL without hash when sourceLocation is null', () => {
		expect(githubLink(meta, 'lib/foo.ts', null)).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts'
		);
	});

	it("'L15' appends #L15", () => {
		expect(githubLink(meta, 'lib/foo.ts', 'L15')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts#L15'
		);
	});

	it("'15' auto-prepends L → #L15", () => {
		expect(githubLink(meta, 'lib/foo.ts', '15')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts#L15'
		);
	});

	it("'15-20' becomes #L15-L20", () => {
		expect(githubLink(meta, 'lib/foo.ts', '15-20')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts#L15-L20'
		);
	});

	it('SSH-style repoUrl is normalized first (no ssh:// in output)', () => {
		const sshMeta = {
			repoUrl: 'git@github.com:darkavengerk/tomboy-web.git',
			branch: 'main'
		};
		const link = githubLink(sshMeta, 'lib/foo.ts', 'L15');
		expect(link).toBe('https://github.com/darkavengerk/tomboy-web/blob/main/lib/foo.ts#L15');
		expect(link).not.toMatch(/^git@/);
		expect(link).not.toMatch(/^ssh:/);
	});

	it('unknown sourceLocation format → URL without hash', () => {
		expect(githubLink(meta, 'lib/foo.ts', 'totally-bogus')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts'
		);
	});

	it('handles a leading slash in sourceFile gracefully', () => {
		expect(githubLink(meta, '/lib/foo.ts', 'L1')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts#L1'
		);
	});

	it("'L15-L20' (already L-prefixed range) becomes #L15-L20", () => {
		expect(githubLink(meta, 'lib/foo.ts', 'L15-L20')).toBe(
			'https://github.com/x/y/blob/main/lib/foo.ts#L15-L20'
		);
	});
});
