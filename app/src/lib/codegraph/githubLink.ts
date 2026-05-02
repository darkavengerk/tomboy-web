/** Normalize SSH/HTTPS git remote URL to https://github.com/<owner>/<repo>. */
export function normalizeRepoUrl(remoteUrl: string): string {
	let url = remoteUrl.trim();
	const sshMatch = url.match(/^git@github\.com:(.+)$/);
	if (sshMatch) {
		url = `https://github.com/${sshMatch[1]}`;
	}
	if (url.endsWith('.git')) {
		url = url.slice(0, -4);
	}
	return url;
}

function formatLineHash(loc: string): string {
	const trimmed = loc.trim();
	if (!trimmed) return '';
	const rangeMatch = trimmed.match(/^L?(\d+)\s*-\s*L?(\d+)$/);
	if (rangeMatch) {
		return `#L${rangeMatch[1]}-L${rangeMatch[2]}`;
	}
	const singleMatch = trimmed.match(/^L?(\d+)$/);
	if (singleMatch) {
		return `#L${singleMatch[1]}`;
	}
	return '';
}

/**
 * Build a GitHub blob URL for a node's source file + optional line.
 * Returns null if sourceFile is empty (caller disables the button).
 *
 * `sourceLocation` formats handled: 'L15', '15', '15-20', null.
 * Anything else → URL without #L hash.
 */
export function githubLink(
	meta: { repoUrl: string; branch: string },
	sourceFile: string,
	sourceLocation: string | null
): string | null {
	if (!sourceFile) return null;
	const repo = normalizeRepoUrl(meta.repoUrl);
	const branch = meta.branch;
	const path = sourceFile.replace(/^\/+/, '');
	const base = `${repo}/blob/${branch}/${path}`;
	if (!sourceLocation) return base;
	const hash = formatLineHash(sourceLocation);
	return base + hash;
}
