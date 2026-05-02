import { describe, it, expect } from 'vitest';
import { normalizeRepoUrl, parseCommunityLabels } from '../../../scripts/sync-codegraph.mjs';

describe('sync-codegraph: normalizeRepoUrl', () => {
	it('SSH form with .git suffix → normalized https URL', () => {
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

describe('sync-codegraph: parseCommunityLabels', () => {
	it('parses the dash + quoted form (primary)', () => {
		const text = '### Community 0 - "Home Note & Misc Utils"';
		expect(parseCommunityLabels(text)).toEqual({
			'0': 'Home Note & Misc Utils'
		});
	});

	it('parses the colon form (fallback)', () => {
		const text = '### Community 1: Schedule Note';
		expect(parseCommunityLabels(text)).toEqual({ '1': 'Schedule Note' });
	});

	it('parses both forms in one report', () => {
		const text = [
			'# Header',
			'',
			'### Community 0 - "Home Note & Misc Utils"',
			'some prose',
			'### Community 1: Schedule Note',
			'### Community 2 - "Admin Cache & Title Invariants"'
		].join('\n');
		expect(parseCommunityLabels(text)).toEqual({
			'0': 'Home Note & Misc Utils',
			'1': 'Schedule Note',
			'2': 'Admin Cache & Title Invariants'
		});
	});

	it('returns {} when there are no community headers', () => {
		const text = '# Title\n\nSome prose without any community headers.\n';
		expect(parseCommunityLabels(text)).toEqual({});
	});

	it('ignores other H3 headings', () => {
		const text = [
			'### God Nodes',
			'### Community Stats',
			'### Some other heading',
			'### Community 5 - "Table Editing (block + cell)"'
		].join('\n');
		expect(parseCommunityLabels(text)).toEqual({
			'5': 'Table Editing (block + cell)'
		});
	});
});
