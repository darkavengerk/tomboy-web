let currentSrc = $state<string | null>(null);

export const imageViewer = {
	get src(): string | null {
		return currentSrc;
	},
	open(src: string) {
		currentSrc = src;
	},
	close() {
		currentSrc = null;
	}
};
