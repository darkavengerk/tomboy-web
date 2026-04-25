/**
 * Lazy Firebase init for the schedule-note push notification feature.
 *
 * Authentication is bridged from Dropbox: we exchange the user's Dropbox
 * access token for a Firebase Custom Auth token whose uid is derived from
 * the Dropbox `account_id`. This way the same Dropbox account always maps
 * to the same Firebase uid across every device, so all schedule items and
 * device tokens land under one `users/{uid}/` namespace and any device
 * can fire alarms for the shared schedule. Without a Dropbox connection,
 * sign-in fails — notifications are gated on Dropbox auth.
 *
 * `getFirebaseMessaging()` returns null when the browser cannot support
 * push (e.g. iOS Safari before 16.4, or any browser where ServiceWorker /
 * Notification APIs are missing). Callers must handle this.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
	getAuth,
	signInWithCustomToken,
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
import { getAccessToken as getDropboxAccessToken } from '$lib/sync/dropboxClient.js';

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
 * Ensure Firebase Auth has a current user, signing in via Dropbox-bridged
 * custom token if needed. Throws DropboxNotConnectedError if the user
 * hasn't completed Dropbox OAuth yet.
 */
export async function ensureSignedIn(): Promise<User> {
	const auth = getFirebaseAuth();
	if (auth.currentUser) return auth.currentUser;

	const dropboxToken = getDropboxAccessToken();
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
