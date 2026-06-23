export type ContinuityChoice = 'none' | 'local' | 'remote' | 'both';

/** Decide whether a play press should pop the local/remote picker.
 *  Picker only when both exist and point at DIFFERENT tracks. */
export function continuityChoice(args: {
	localTrackUrl: string | null;
	remoteTrackUrl: string | null;
}): ContinuityChoice {
	const { localTrackUrl, remoteTrackUrl } = args;
	if (!localTrackUrl && !remoteTrackUrl) return 'none';
	if (localTrackUrl && !remoteTrackUrl) return 'local';
	if (!localTrackUrl && remoteTrackUrl) return 'remote';
	return localTrackUrl === remoteTrackUrl ? 'local' : 'both';
}
