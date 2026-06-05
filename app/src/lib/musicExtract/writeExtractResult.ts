import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { itemSource } from '$lib/musicExtract/parseExtractNote.js';

export type ResultPayload =
	| { kind: 'done'; url: string; title: string }
	| { kind: 'error'; message: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESULT_URL_RE = new RegExp(`/files/${UUID}/`, 'i');

function isList(node: PMNode): boolean {
	return node.type.name === 'bulletList' || node.type.name === 'orderedList';
}

function liIsDone(li: PMNode): boolean {
	let done = false;
	li.descendants((n) => {
		if (done) return false;
		if (n.isText) {
			const link = n.marks.find((m) => m.type.name === 'tomboyUrlLink' || m.type.name === 'link');
			const href = (link?.attrs?.href as string) ?? '';
			if (RESULT_URL_RE.test(href) || RESULT_URL_RE.test(n.text ?? '')) {
				done = true;
				return false;
			}
		}
		return true;
	});
	return done;
}

function linkText(schema: Schema, text: string, href: string) {
	const markType = schema.marks.tomboyUrlLink ?? schema.marks.link;
	if (markType) return schema.text(text, [markType.create({ href })]);
	// マーク없으면 텍스트+URL 둘 다(파서가 URL 인식)
	return schema.text(`${text} ${href}`);
}

/** source 헤드를 가진 첫 '미완료' top-level listItem 밑에 결과 자식을 기록(라이브 dispatch). */
export function writeExtractResult(view: EditorView, source: string, payload: ResultPayload): void {
	if (view.isDestroyed) return;
	const { state } = view;
	const { schema, doc } = state;
	const bulletList = schema.nodes.bulletList;
	const listItem = schema.nodes.listItem;
	const paragraph = schema.nodes.paragraph;
	if (!bulletList || !listItem || !paragraph) return;

	interface LiTarget { liPos: number; node: PMNode }
	interface NestedTarget { pos: number; node: PMNode }

	let target: LiTarget | null = null;
	doc.forEach((block: PMNode, blockOffset: number) => {
		if (target || !isList(block)) return;
		block.forEach((li: PMNode, liOffset: number) => {
			if (target || li.type.name !== 'listItem') return;
			if (itemSource(li) === source && !liIsDone(li)) {
				target = { liPos: blockOffset + 1 + liOffset, node: li };
			}
		});
	});
	if (!target) return;
	const resolvedTarget: LiTarget = target;

	const childPara =
		payload.kind === 'done'
			? paragraph.create(null, linkText(schema, payload.title || payload.url, payload.url))
			: paragraph.create(null, schema.text(`❌ 실패: ${payload.message}`));
	const childItem = listItem.create(null, childPara);

	const li = resolvedTarget.node;
	let nested: NestedTarget | null = null;
	li.forEach((child: PMNode, childOffset: number) => {
		if (!nested && isList(child)) {
			nested = { pos: resolvedTarget.liPos + 1 + childOffset, node: child };
		}
	});

	const tr = state.tr;
	if (nested) {
		const resolvedNested: NestedTarget = nested;
		tr.replaceWith(
			resolvedNested.pos,
			resolvedNested.pos + resolvedNested.node.nodeSize,
			bulletList.create(resolvedNested.node.attrs, childItem)
		);
	} else {
		const headSize = li.firstChild?.nodeSize ?? 0;
		tr.insert(resolvedTarget.liPos + 1 + headSize, bulletList.create(null, childItem));
	}
	view.dispatch(tr);
}
