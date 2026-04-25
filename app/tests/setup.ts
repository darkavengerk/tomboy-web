import '@testing-library/jest-dom';
import { vi } from 'vitest';

// SvelteKit virtual env modules — stub so any module that imports from
// `$env/dynamic/public` or `$env/static/public` works under vitest.
const publicEnv = {
	PUBLIC_DROPBOX_APP_KEY: 'test-app-key',
	PUBLIC_FIREBASE_API_KEY: 'test-fb-api-key',
	PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
	PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
	PUBLIC_FIREBASE_STORAGE_BUCKET: 'test.firebasestorage.app',
	PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '0',
	PUBLIC_FIREBASE_APP_ID: '1:0:web:test',
	PUBLIC_FIREBASE_VAPID_KEY: 'test-vapid-key'
};

vi.mock('$env/dynamic/public', () => ({ env: publicEnv }));
vi.mock('$env/static/public', () => publicEnv);
