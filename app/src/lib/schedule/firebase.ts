/**
 * Lazy Firebase init for the schedule-note push notification feature.
 *
 * All getters are memoised so the SDK is initialised exactly once per page,
 * and only when first needed (settings page, save hook, SW push). Tests stub
 * `$env/static/public` so calling `getFirebaseApp()` in unit tests is safe
 * even though tests never actually round-trip to Firebase.
 *
 * `getFirebaseMessaging()` returns null when the browser cannot support push
 * (e.g. iOS Safari before 16.4, or any browser where ServiceWorker /
 * Notification APIs are missing). Callers must handle this.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
	getAuth,
	signInAnonymously,
	type Auth,
	type User
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import {
	getMessaging,
	isSupported,
	type Messaging
} from 'firebase/messaging';
import { env } from '$env/dynamic/public';

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

/** Sign in anonymously if no current user. Returns the resolved User. */
export async function ensureSignedIn(): Promise<User> {
	const auth = getFirebaseAuth();
	if (auth.currentUser) return auth.currentUser;
	const cred = await signInAnonymously(auth);
	return cred.user;
}

/** Test-only reset of singletons. */
export function _resetFirebaseForTest(): void {
	appSingleton = null;
	authSingleton = null;
	firestoreSingleton = null;
	messagingSingleton = undefined;
}
