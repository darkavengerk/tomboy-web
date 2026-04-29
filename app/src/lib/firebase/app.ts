/**
 * Shared lazy Firebase init.
 *
 * Originally introduced for the schedule-note push notification feature; now
 * also backs Firestore-based realtime note sync. Lives in `$lib/firebase/`
 * because both feature areas need the same singletons and the same
 * Dropbox-bridged auth identity.
 *
 * Authentication is bridged from Dropbox: we exchange the user's Dropbox
 * access token for a Firebase Custom Auth token whose uid is derived from
 * the Dropbox `account_id`. This way the same Dropbox account always maps
 * to the same Firebase uid across every device, so all schedule items,
 * device tokens, and synced notes land under one `users/{uid}/` namespace
 * and any device can act on the shared data. Without a Dropbox connection,
 * sign-in fails — every Firebase-backed feature is gated on Dropbox auth.
 *
 * `getFirebaseMessaging()` returns null when the browser cannot support
 * push (e.g. iOS Safari before 16.4, or any browser where ServiceWorker /
 * Notification APIs are missing). Callers must handle this.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
	getAuth,
	signInWithCustomToken,
	signOut,
	type Auth,
	type User
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
	getMessaging,
	isSupported,
	type Messaging
} from 'firebase/messaging';
import { env } from '$env/dynamic/public';
import { getFreshAccessToken as getFreshDropboxAccessToken } from '$lib/sync/dropboxClient.js';

let appSingleton: FirebaseApp | null = null;
let authSingleton: Auth | null = null;
let firestoreSingleton: Firestore | null = null;
let messagingSingleton: Messaging | null | undefined;

function configFromEnv() {
	return {
		apiKey: env.PUBLIC_FIREBASE_API_KEY,
		authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
		projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
		storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET,
		messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
		appId: env.PUBLIC_FIREBASE_APP_ID
	};
}

export function getFirebaseApp(): FirebaseApp {
	if (!appSingleton) appSingleton = initializeApp(configFromEnv());
	return appSingleton;
}

export function getFirebaseAuth(): Auth {
	if (!authSingleton) authSingleton = getAuth(getFirebaseApp());
	return authSingleton;
}

export function getFirebaseFirestore(): Firestore {
	if (!firestoreSingleton) firestoreSingleton = getFirestore(getFirebaseApp());
	return firestoreSingleton;
}

/** Returns null when push isn't supported in the current browser. */
export async function getFirebaseMessaging(): Promise<Messaging | null> {
	if (messagingSingleton !== undefined) return messagingSingleton;
	const supported = await isSupported().catch(() => false);
	messagingSingleton = supported ? getMessaging(getFirebaseApp()) : null;
	return messagingSingleton;
}

export function getVapidKey(): string {
	return env.PUBLIC_FIREBASE_VAPID_KEY;
}

export class DropboxNotConnectedError extends Error {
	constructor() {
		super('Dropbox not connected');
		this.name = 'DropboxNotConnectedError';
	}
}

/**
 * Ensure Firebase Auth has a Dropbox-bridged user. Anonymous sessions
 * (left over from before the auth bridge was wired in) are force-signed-out
 * so the next call goes through `dropboxAuthExchange` and the user lands
 * on the stable `dbx-{account_id}` uid.
 *
 * Awaits `authStateReady()` first so a cold-start call doesn't race
 * Firebase's IndexedDB persistence restore — without it, `currentUser`
 * is briefly null after page load and we'd needlessly call the exchange
 * (which then fails if the cached Dropbox access_token has expired).
 *
 * The Dropbox token is refreshed via `getFreshAccessToken()` before
 * being handed to the exchange function, so a 4-hour-idle access_token
 * doesn't cause an `expired_access_token` 401 from the Cloud Function.
 *
 * Throws DropboxNotConnectedError if the user hasn't completed Dropbox
 * OAuth yet.
 */
export async function ensureSignedIn(): Promise<User> {
	const auth = getFirebaseAuth();
	await auth.authStateReady();
	if (auth.currentUser?.isAnonymous) {
		console.info('[firebase] signing out leftover anonymous user');
		await signOut(auth);
	}
	if (auth.currentUser) return auth.currentUser;

	const dropboxToken = await getFreshDropboxAccessToken();
	if (!dropboxToken) throw new DropboxNotConnectedError();

	const functions = getFunctions(getFirebaseApp(), 'asia-northeast3');
	const exchange = httpsCallable<
		{ dropboxAccessToken: string },
		{ customToken: string; uid: string }
	>(functions, 'dropboxAuthExchange');
	const { data } = await exchange({ dropboxAccessToken: dropboxToken });
	const cred = await signInWithCustomToken(auth, data.customToken);
	return cred.user;
}

/** Test-only reset of singletons. */
export function _resetFirebaseForTest(): void {
	appSingleton = null;
	authSingleton = null;
	firestoreSingleton = null;
	messagingSingleton = undefined;
}
