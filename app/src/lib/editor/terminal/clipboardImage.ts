/**
 * `navigator.clipboard.read()`가 반환하는 ClipboardItem 배열에서 첫 번째
 * 이미지 항목을 추출해 `File`로 만들어 반환. 이미지 없으면 null.
 *
 * TerminalView의 `onClickPasteImage`가 이 헬퍼를 호출 — 헬퍼를 분리해
 * 단위 테스트 가능하게 한다. (ClipboardEvent의 clipboardData는 다른
 * 함수 — imagePasteClient의 extractImageFile — 가 다룬다.)
 */
export async function extractImageFromClipboardItems(
	items: ClipboardItem[]
): Promise<File | null> {
	for (const item of items) {
		for (const type of item.types) {
			if (type.startsWith('image/')) {
				const blob = await item.getType(type);
				return new File([blob], 'pasted', { type });
			}
		}
	}
	return null;
}
