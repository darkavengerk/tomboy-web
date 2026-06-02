/**
 * Transient, in-memory hand-off from note *creation* to the editor's first
 * load of that note. Lets the editor know whether the freshly-created note's
 * title was auto-generated (so select the whole title — one keystroke replaces
 * the date) or was already chosen by the caller (so drop the cursor in the
 * body instead).
 *
 * Keyed by guid and consumed once (delete-on-read). Not persisted: a hard page
 * reload is not a fresh creation, so a dropped entry is the correct outcome —
 * and reopening an existing note simply has no entry, leaving the editor's
 * default "no auto-focus" behaviour untouched.
 */
export type NewNoteIntent = 'selectTitle' | 'bodyCursor';

const pending = new Map<string, NewNoteIntent>();

export function setNewNoteIntent(guid: string, intent: NewNoteIntent): void {
	pending.set(guid, intent);
}

/** Read and remove the intent for `guid`, or `undefined` if none was set. */
export function consumeNewNoteIntent(guid: string): NewNoteIntent | undefined {
	const intent = pending.get(guid);
	pending.delete(guid);
	return intent;
}
