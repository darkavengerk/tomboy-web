// Markdown 서브셋 ↔ Tomboy <note-content> XML.
// 앱 noteContentArchiver.ts 직렬화 규약 미러: bold / monospace / link:internal / list(list-item dir="ltr").
// 헤딩 레벨(#~######)은 전부 <bold>로 축퇴 — 역변환은 항상 ## 로 복원(레벨 정보 손실은 의도).
// 미지원(의도): 표, ---(hrSplit 트리거라 드롭), 이미지, italic/strike.
// [x]/[ ]는 평문 통과 — 앱이 체크박스 atom으로 렌더.
// 평문 속 리터럴 **/[[]]/백틱은 브릿지 재작성 시 마크로 해석됨 (이스케이프 층 없음 — 의도적 한계)
// 헤딩 텍스트 안의 **는 중첩 bold XML을 만듦 — 앱이 병합 재직렬화하므로 무해하나 churn 가능
// 여러 줄에 걸친 <bold>는 줄별 ## 로 축퇴 (bold↔헤딩 융합의 일관 결과)

export function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function unescapeXml(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

// 인라인 md → XML. 코드 스팬(`...`)을 먼저 분리해 불투명 처리 — 백틱 안은 escapeXml만 적용하고
// link/bold 치환은 백틱 밖 세그먼트에만 적용한다(코드 안 리터럴 **/[[]]가 마크로 오인되는 것 방지).
function inlineToXml(text: string): string {
	const parts = text.split(/(`[^`]+`)/g);
	return parts
		.map((part, idx) => {
			// split의 캡처 그룹 매치는 항상 홀수 인덱스 — 코드 스팬(백틱 포함) 자체.
			if (idx % 2 === 1) {
				return `<monospace>${escapeXml(part.slice(1, -1))}</monospace>`;
			}
			let s = escapeXml(part);
			s = s.replace(/\[\[(.+?)\]\]/g, (_m, t: string) => `<link:internal>${t}</link:internal>`);
			s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => `<bold>${t}</bold>`);
			return s;
		})
		.join('');
}

interface ListNode {
	text: string;
	children: ListNode[];
}

function buildTree(flat: Array<{ depth: number; text: string }>, depth: number): ListNode[] {
	const out: ListNode[] = [];
	let i = 0;
	while (i < flat.length) {
		if (flat[i].depth <= depth) {
			const node: ListNode = { text: flat[i].text, children: [] };
			i++;
			const start = i;
			while (i < flat.length && flat[i].depth > depth) i++;
			node.children = buildTree(flat.slice(start, i), depth + 1);
			out.push(node);
		} else {
			i++;
		}
	}
	return out;
}

// 규약: 최상위 리스트의 마지막 항목만 트레일링 \n 없음, 그 외 </list-item> 직전 \n.
// 중첩 <list>는 부모 텍스트 + \n 뒤 list-item 안에.
function serializeList(items: ListNode[], isTop: boolean): string {
	const parts: string[] = [];
	items.forEach((it, i) => {
		let inner = inlineToXml(it.text);
		if (it.children.length > 0) inner += '\n' + serializeList(it.children, false);
		const last = isTop && i === items.length - 1;
		parts.push(`<list-item dir="ltr">${inner}${last ? '' : '\n'}</list-item>`);
	});
	return `<list>${parts.join('')}</list>`;
}

export function mdToNoteContent(title: string, md: string): string {
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	const blocks: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^```/.test(line)) {
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				blocks.push(`<monospace>${escapeXml(lines[i])}</monospace>`);
				i++;
			}
			i++; // 닫는 펜스
			continue;
		}
		if (/^-{3,}\s*$/.test(line)) {
			i++; // hrSplit 트리거 회피 — 드롭
			continue;
		}
		const h = /^#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			blocks.push(`<bold>${inlineToXml(h[1])}</bold>`);
			i++;
			continue;
		}
		if (/^(\s*)- /.test(line)) {
			const flat: Array<{ depth: number; text: string }> = [];
			const indents: number[] = []; // 열린 깊이 레벨별 raw indent (index = depth)
			while (i < lines.length) {
				const m = /^(\s*)- (.*)$/.exec(lines[i]);
				if (!m) break;
				const w = m[1].length;
				while (indents.length > 0 && w < indents[indents.length - 1]) indents.pop();
				let depth: number;
				if (indents.length === 0) {
					indents.push(w);
					depth = 0;
				} else if (w === indents[indents.length - 1]) {
					depth = indents.length - 1;
				} else {
					indents.push(w);
					depth = indents.length - 1;
				}
				flat.push({ depth, text: m[2] });
				i++;
			}
			blocks.push(serializeList(buildTree(flat, 0), true));
			continue;
		}
		blocks.push(inlineToXml(line));
		i++;
	}
	return `<note-content version="0.1">${escapeXml(title)}\n\n${blocks.join('\n')}</note-content>`;
}

// XML → md. 미지 태그는 텍스트만 유지(앱 파서와 동일 관용).
export function noteContentToMd(xmlContent: string): { title: string; markdown: string } {
	const m = /<note-content[^>]*>([\s\S]*)<\/note-content>/.exec(xmlContent);
	const inner = m ? m[1] : xmlContent;
	const lines: string[] = [];
	let cur = '';
	let started = false; // cur에 내용/프리픽스가 실렸는지
	const stack: string[] = [];
	let listDepth = 0;
	let swallowNewline = false; // </list> 직후 블록 구분 \n 1개 삼킴
	let boldOpen = false; // cur에 아직 안 닫힌 ** 마커가 있는지(볼드 런 병합용)
	const flush = () => {
		if (boldOpen) {
			cur += '**';
			boldOpen = false;
		}
		lines.push(cur);
		cur = '';
		started = false;
	};
	const tokenRe = /<(\/?)([A-Za-z0-9:_-]+)(?:\s[^>]*)?>|([^<]+)/g;
	let t: RegExpExecArray | null;
	while ((t = tokenRe.exec(inner))) {
		if (t[3] !== undefined) {
			const parts = t[3].split('\n');
			parts.forEach((rawPart, idx) => {
				if (idx > 0) {
					if (swallowNewline) {
						swallowNewline = false;
					} else if (started || !stack.includes('list-item')) {
						// cur가 비어 있고(started=false) 아직 열린 list-item 안이면 이 \n은
						// "중첩 리스트를 닫고 부모 list-item으로 복귀" 구분자일 뿐 —
						// 빈 줄로 flush하면 md에 유령 공백 줄이 생긴다.
						flush();
					}
				}
				if (rawPart === '') return;
				swallowNewline = false;
				const p = unescapeXml(rawPart);
				// 마크 합성: bold는 조각 경계를 넘나드는 "런"이라 상태가 바뀔 때만 **를 여닫아
				// 연속된 볼드 조각을 하나의 **...**로 병합한다. link/monospace는 자기 완결적이라
				// 조각 그대로 안쪽에 감싼다 — 결과적으로 bold가 바깥, link/mono가 안쪽으로 합성됨.
				const inBold = stack.includes('bold');
				if (inBold !== boldOpen) {
					cur += '**';
					boldOpen = inBold;
				}
				if (stack.includes('link:internal') || stack.includes('link:broken')) cur += `[[${p}]]`;
				else if (stack.includes('monospace')) cur += `\`${p}\``;
				else cur += p;
				started = true;
			});
			continue;
		}
		const closing = t[1] === '/';
		const tag = t[2];
		if (!closing) {
			stack.push(tag);
			if (tag === 'list') listDepth++;
			if (tag === 'list-item') {
				cur = '  '.repeat(Math.max(0, listDepth - 1)) + '- ';
				started = true;
			}
		} else {
			const idx = stack.lastIndexOf(tag);
			if (idx >= 0) stack.splice(idx, 1);
			if (tag === 'list') {
				listDepth--;
				if (listDepth === 0) swallowNewline = true;
			}
			if (tag === 'list-item' && started) flush();
		}
	}
	if (started || cur) flush();
	const mdLines = lines.map((l) => {
		const h = /^\*\*((?:(?!\*\*).)+)\*\*$/.exec(l);
		return h ? `## ${h[1]}` : l;
	});
	const title = (mdLines[0] ?? '').trim();
	const body = mdLines.slice(1);
	while (body.length && body[0].trim() === '') body.shift();
	while (body.length && body[body.length - 1].trim() === '') body.pop();
	return { title, markdown: body.join('\n') };
}
