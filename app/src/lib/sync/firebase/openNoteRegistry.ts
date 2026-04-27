/**
 * Refcounted registry of currently open notes.
 *
 * The mobile route and every desktop NoteWindow call `attach(guid)` after the
 * note loads from IDB and `detach(guid)` on unmount. The registry asks the
 * injected `start` callback to begin a Firestore subscription on the first
 * attach for a guid and runs the returned unsubscribe handle once the last
 * detach lands. Multiple windows holding the same note share one subscription.
 *
 * Echo-suppression for our own writes is handled implicitly by
 * {@link resolveNoteConflict} returning `noop` when local and remote payloads
 * are equivalent, so the registry has no opinion on snapshot contents.
 */
export type Unsubscribe = () => void;

export interface OpenNoteRegistryOptions {
	start: (guid: string) => Unsubscribe;
}

export interface OpenNoteRegistry {
	attach(guid: string): void;
	detach(guid: string): void;
	detachAll(): void;
	isOpen(guid: string): boolean;
	openCount(): number;
}

interface Entry {
	count: number;
	unsub: Unsubscribe;
}

export function createOpenNoteRegistry(
	opts: OpenNoteRegistryOptions
): OpenNoteRegistry {
	const entries = new Map<string, Entry>();

	function attach(guid: string): void {
		const e = entries.get(guid);
		if (e) {
			e.count += 1;
			return;
		}
		const unsub = opts.start(guid);
		entries.set(guid, { count: 1, unsub });
	}

	function detach(guid: string): void {
		const e = entries.get(guid);
		if (!e) return;
		e.count -= 1;
		if (e.count > 0) return;
		entries.delete(guid);
		safeUnsub(e.unsub);
	}

	function detachAll(): void {
		for (const e of entries.values()) safeUnsub(e.unsub);
		entries.clear();
	}

	function isOpen(guid: string): boolean {
		return entries.has(guid);
	}

	function openCount(): number {
		return entries.size;
	}

	return { attach, detach, detachAll, isOpen, openCount };
}

function safeUnsub(unsub: Unsubscribe): void {
	try {
		unsub();
	} catch (err) {
		console.warn('[openNoteRegistry] unsubscribe threw', err);
	}
}
