/**
 * State for the note-image action menu (이미지 복사 / 이미지 주소 복사).
 * Opened by right-click (desktop) or long-press (mobile) on a note image,
 * from both the inline preview and the full-screen viewer. Mirrors the
 * `imageViewer` store; the menu component is mounted once at the app root.
 */

export interface ImageMenuState {
	x: number;
	y: number;
	href: string;
}

let current = $state<ImageMenuState | null>(null);

export const imageActionMenu = {
	get state(): ImageMenuState | null {
		return current;
	},
	open(x: number, y: number, href: string) {
		current = { x, y, href };
	},
	close() {
		current = null;
	}
};
