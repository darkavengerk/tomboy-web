import { writable } from 'svelte/store';
import type { NoteData } from '$lib/core/note.js';

/** Reactive store for the list of notes */
export const notes = writable<NoteData[]>([]);

/** Currently active note GUID (for the editor view) */
export const activeNoteGuid = writable<string | null>(null);
