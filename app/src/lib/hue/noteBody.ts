/** note.xmlContent(<note-content>title\nsecond\n...) 에서 본문 첫 보이는 줄(2번째 줄) 추출. */
export function firstBodyLineOf(xmlContent: string): string {
  const m = /<note-content[^>]*>([\s\S]*?)<\/note-content>/.exec(xmlContent);
  const inner = m ? m[1] : xmlContent;
  const lines = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
  return lines[1] ?? '';
}
