import type { EditorView } from "@tiptap/pm/view";

// Mobile "명령 모드" keyboard suppression.
//
// The mobile editor toolbar has "Ctrl 고정" / "Alt 고정" toggles. While one is
// on, the next thing the user does is fire a shortcut button — not type. Tapping
// the note to place the caret should therefore NOT raise the on-screen keyboard;
// it only gets in the way and has to be dismissed by hand.
//
// `inputmode="none"` is the right lever: it keeps the contenteditable focusable
// and selectable (so the caret still lands where the user taps, and the shortcut
// command acts on that position) while telling the browser to show no virtual
// keyboard. Removing the attribute restores the normal text keyboard.
//
// Setting `inputmode="none"` on an already-focused element doesn't retract a
// keyboard that's already up, so when a lock turns on while the editor holds
// focus we also blur once to drop it. ProseMirror keeps its selection across the
// DOM blur (the unfocused-caret plugin renders it), and the shortcut commands
// operate on view state regardless of focus, so nothing is lost.
//
// Desktop never sets the lock toggles (physical Ctrl/Alt set a separate flag),
// so this is inert there.
export function applyCommandModeKeyboard(
	view: Pick<EditorView, "dom" | "hasFocus">,
	locked: boolean,
): void {
	const dom = view.dom as HTMLElement;
	if (locked) {
		dom.setAttribute("inputmode", "none");
		if (view.hasFocus()) dom.blur();
	} else {
		dom.removeAttribute("inputmode");
	}
}
