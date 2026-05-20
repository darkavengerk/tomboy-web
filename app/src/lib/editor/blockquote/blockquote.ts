/**
 * 인용 단락 탐색 (순수 함수).
 *
 * '> '(꺾쇠 + 공백)로 시작하는 최상위 단락이 인용 단락이다. 제목(0번
 * 단락)과 리스트 내부 단락은 제외한다. 마커 '> ' 는 라이브 문서와
 * .note XML 양쪽에 텍스트로 남는다 — 아카이버 비경유.
 */
import type { Node as PMNode } from '@tiptap/pm/model';

/** 텍스트가 '> '(꺾쇠+공백)로 시작하면 인용 단락. */
export function isQuotedParagraphText(text: string): boolean {
	return /^> /.test(text);
}

export interface QuotedParagraph {
	/** 단락 노드의 절대 위치. */
	paraPos: number;
	paraNode: PMNode;
	/** 단락 내용 시작 위치 = paraPos + 1 (첫 인라인 콘텐츠의 절대 위치). */
	textStart: number;
}

/** 문서의 인용 최상위 단락을 문서 순서대로 반환. 제목(0번) 제외. */
export function findQuotedParagraphs(doc: PMNode): QuotedParagraph[] {
	const out: QuotedParagraph[] = [];
	doc.forEach((node, offset, index) => {
		if (index === 0) return; // 제목 제외
		if (node.type.name !== 'paragraph') return; // 최상위 단락만
		if (!isQuotedParagraphText(node.textContent)) return;
		out.push({ paraPos: offset, paraNode: node, textStart: offset + 1 });
	});
	return out;
}
