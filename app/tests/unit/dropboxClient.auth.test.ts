import { describe, it, expect, vi } from 'vitest';

vi.mock('$env/static/public', () => ({
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
}));

vi.mock('dropbox', () => {
	class DropboxAuth {
		setAccessToken() {}
		setRefreshToken() {}
	}
	class Dropbox {}
	return { Dropbox, DropboxAuth };
});

import { forceReapproveUrl } from '$lib/sync/dropboxClient.js';

describe('forceReapproveUrl', () => {
	// Without `force_reapprove=true`, Dropbox silently re-grants a user's
	// previously-approved scopes when they "reconnect" — if the app has
	// since added new scopes, those are NOT prompted for (because no
	// consent screen shows), and the new token lacks them. Appending this
	// flag forces the consent screen every time so scope migrations are
	// visible to the user.
	it('appends force_reapprove=true when the base URL has no query string', () => {
		expect(forceReapproveUrl('https://www.dropbox.com/oauth2/authorize')).toBe(
			'https://www.dropbox.com/oauth2/authorize?force_reapprove=true'
		);
	});

	it('appends with & when the base URL already has a query string', () => {
		expect(
			forceReapproveUrl(
				'https://www.dropbox.com/oauth2/authorize?client_id=abc&scope=x+y'
			)
		).toBe(
			'https://www.dropbox.com/oauth2/authorize?client_id=abc&scope=x+y&force_reapprove=true'
		);
	});

	it('does not duplicate force_reapprove when already present', () => {
		// Keep the helper idempotent — double-append would produce a URL
		// with two force_reapprove params, which Dropbox may reject.
		expect(
			forceReapproveUrl(
				'https://www.dropbox.com/oauth2/authorize?client_id=abc&force_reapprove=true'
			)
		).toBe(
			'https://www.dropbox.com/oauth2/authorize?client_id=abc&force_reapprove=true'
		);
	});
});
