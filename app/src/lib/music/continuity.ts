export type ContinuityChoice = 'none' | 'local' | 'remote' | 'both';

/** Decide whether a play press should pop the local/remote picker.
 *
 *  Picker ('both') only when local and remote point at DIFFERENT tracks from
 *  DIFFERENT source notes. If both tracks live in the SAME source note (same
 *  playlist), they're treated as "the same song, different position" — no
 *  picker; the most-recently-active side wins automatically (remote when its
 *  record is newer than ours, else local). Same exact track always resumes
 *  local. */
export function continuityChoice(args: {
	localTrackUrl: string | null;
	remoteTrackUrl: string | null;
	/** Source music-note guid of the local / remote track (the playlist). */
	localNoteGuid?: string | null;
	remoteNoteGuid?: string | null;
	/** ISO-8601 of each side's last action — sorts lexically. Used only to pick
	 *  the newer side when the sources match. */
	localUpdatedAt?: string | null;
	remoteUpdatedAt?: string | null;
}): ContinuityChoice {
	const { localTrackUrl, remoteTrackUrl, localNoteGuid, remoteNoteGuid } = args;
	if (!localTrackUrl && !remoteTrackUrl) return 'none';
	if (localTrackUrl && !remoteTrackUrl) return 'local';
	if (!localTrackUrl && remoteTrackUrl) return 'remote';
	if (localTrackUrl === remoteTrackUrl) return 'local';
	// Different tracks. If they share a source note, don't prompt — auto-adopt
	// whichever side acted more recently (remote when newer, else stay local).
	if (localNoteGuid && remoteNoteGuid && localNoteGuid === remoteNoteGuid) {
		const { localUpdatedAt, remoteUpdatedAt } = args;
		if (localUpdatedAt && remoteUpdatedAt) {
			return remoteUpdatedAt > localUpdatedAt ? 'remote' : 'local';
		}
		// Local action time unknown (fresh boot, restored session) → the remote
		// record is the latest known cross-device state.
		return 'remote';
	}
	return 'both';
}
