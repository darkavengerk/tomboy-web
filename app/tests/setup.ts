import '@testing-library/jest-dom';
import { vi } from 'vitest';

// SvelteKit virtual env modules — stub so any module that imports from
// `$env/dynamic/public` or `$env/static/public` works under vitest.
vi.mock('$env/dynamic/public', () => ({
	env: {
		PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
	}
}));

vi.mock('$env/static/public', () => ({
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key'
}));
