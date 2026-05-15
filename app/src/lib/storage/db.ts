import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface TomboyDB extends DBSchema {
	notes: {
		key: string;
		value: {
			guid: string;
			uri: string;
			title: string;
			xmlContent: string;
			createDate: string;
			changeDate: string;
			metadataChangeDate: string;
			cursorPosition: number;
			selectionBoundPosition: number;
			width: number;
			height: number;
			x: number;
			y: number;
			tags: string[];
			openOnStartup: boolean;
			localDirty: boolean;
			deleted: boolean;
			syncedXmlContent?: string;
		};
		indexes: {
			'by-changeDate': string;
			'by-title': string;
			'by-localDirty': number;
			'by-deleted': number;
		};
	};
	syncManifest: {
		key: string;
		value: {
			id: string;
			lastSyncDate: string;
			lastSyncRev: number;
			serverId: string;
			noteRevisions: Record<string, number>;
		};
	};
	appSettings: {
		key: string;
		value: { id: string; value: unknown };
	};
}

const HOST_DB_NAME = 'tomboy-web';
const GUEST_DB_NAME = 'tomboy-web-guest';
const DB_VERSION = 3;

type DbMode = 'host' | 'guest';

let dbMode: DbMode = 'host';
let dbPromise: Promise<IDBPDatabase<TomboyDB>> | null = null;
let dbPromiseMode: DbMode | null = null;

export function setDbMode(m: DbMode): void {
	if (m === dbMode) return;
	dbMode = m;
	// Force a fresh handle on next getDB().
	dbPromise = null;
	dbPromiseMode = null;
}

export function getDbName(): string {
	return dbMode === 'guest' ? GUEST_DB_NAME : HOST_DB_NAME;
}

export function getDB(): Promise<IDBPDatabase<TomboyDB>> {
	if (!dbPromise || dbPromiseMode !== dbMode) {
		dbPromiseMode = dbMode;
		dbPromise = openDB<TomboyDB>(getDbName(), DB_VERSION, {
			upgrade(db, oldVersion) {
				if (oldVersion < 1) {
					const noteStore = db.createObjectStore('notes', { keyPath: 'guid' });
					noteStore.createIndex('by-changeDate', 'changeDate');
					noteStore.createIndex('by-title', 'title');
					noteStore.createIndex('by-localDirty', 'localDirty');
					noteStore.createIndex('by-deleted', 'deleted');

					db.createObjectStore('syncManifest', { keyPath: 'id' });
				}

				if (oldVersion < 2) {
					// Sync format changed to Tomboy revision protocol — clear old manifest
					if (db.objectStoreNames.contains('syncManifest')) {
						db.deleteObjectStore('syncManifest');
					}
					db.createObjectStore('syncManifest', { keyPath: 'id' });
				}

				if (oldVersion < 3) {
					db.createObjectStore('appSettings', { keyPath: 'id' });
				}
			}
		});
	}
	return dbPromise;
}

/** Reset DB promise (for testing with fake-indexeddb) */
export function _resetDBForTest(): void {
	dbPromise = null;
	dbPromiseMode = null;
	dbMode = 'host';
}

export type { TomboyDB };
