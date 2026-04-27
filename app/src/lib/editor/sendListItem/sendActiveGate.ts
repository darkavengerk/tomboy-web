export function shouldSendListBeActive(args: {
	guid: string;
	sourceGuid: string;
	ctrlHeld: boolean;
	focusedGuid: string | null;
	/** Mobile route has no multi-window focus concept; pass true to skip the focus check. */
	ignoreFocus?: boolean;
}): boolean {
	const { guid, sourceGuid, ctrlHeld, focusedGuid, ignoreFocus = false } = args;
	return guid === sourceGuid && ctrlHeld && (ignoreFocus || focusedGuid === guid);
}
