// Classifies a click inside the mobile note route's `.editor-area` as a
// "whitespace" tap — the affordance that focuses the caret at the END of the
// document so short notes don't require landing precisely on text to bring up
// the keyboard.
//
// TipTap's focus() scrolls the selection into view by default, so anything
// that reaches focus('end') from the middle of a long note is a full-page
// jump. The bars mounted inside `.editor-area` (MusicPlayerBar / ChatSendBar /
// RemarkableActionBar) and the find bar do NOT stopPropagation — their taps
// bubble into the area's click handler — so they must be excluded here, along
// with any interactive element. Clicks on the contenteditable itself are left
// to the browser's native caret placement.
export function isEditorAreaWhitespaceClick(target: Element | null): boolean {
	if (!target) return false;
	if (target.closest(".tiptap")) return false;
	if (
		target.closest(
			"button, a, input, textarea, select, [role='button']," +
				" .find-bar-slot, .music-bar, .llm-send-bar, .rm-bar",
		)
	) {
		return false;
	}
	return true;
}
