/**
 * Slip-Note format validator.
 *
 * "Slip-Note" = a note in the `[0] Slip-Box` notebook that participates in a
 * linked-list structure rooted at the fixed index note (INDEX_NOTE_GUID).
 *
 * The index note's `이론` / `실용` / `기록` sections contain lists whose
 * internal links point to the HEAD of each topic's chain. From each HEAD, the
 * chain is followed by reading the `다음` line of each note until it becomes
 * empty / "없음".
 *
 * Slip-Note expected block layout (TipTap JSON, as produced by
 * `deserializeContent`):
 *   [0] paragraph  — title (must equal note.title)
 *   [1] paragraph  — empty (blank line)
 *   [2] paragraph  — "이전: " + (empty | "없음" | single internal link)
 *   [3] paragraph  — "다음: " + (empty | "없음" | single internal link)
 *   [4] paragraph  — empty (blank line)
 *   [5+]           — free-form content
 *
 * Enforcing this format lets future automation (chain splicing, bulk renames,
 * reorders) manipulate the prev/next fields mechanically.
 */

import type { JSONContent } from '@tiptap/core';
import { deserializeContent } from '$lib/core/noteContentArchiver.js';
import { getNotebook } from '$lib/core/notebooks.js';
import { getAllNotes } from '$lib/storage/noteStore.js';
import type { NoteData } from '$lib/core/note.js';

export const SLIPBOX_NOTEBOOK = '[0] Slip-Box';
export const INDEX_NOTE_GUID = '1c97d161-1489-4c32-93d9-d8c383330b9c';
export const SECTION_HEADINGS = ['이론', '실용', '기록'] as const;
export type SectionHeading = (typeof SECTION_HEADINGS)[number];

// Slip-notes are identified by their title format. Two shapes are accepted:
//   "Slip-Box::..."              — the historical numbered chain prefix.
//   "yyyy-mm-dd HH:mm ..."       — date-time titled notes that were promoted
//                                  to chain HEADs (e.g. "2025-10-31 11:08 메타인지").
// Links in the index that don't match either shape are ignored by the checker
// — they're regular notes that happen to appear in the index for context.
const SLIP_BOX_PREFIX = /^Slip-Box::/;
const DATE_TIME_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/;

export function isSlipNoteTitle(title: string): boolean {
	const t = title.trim();
	return SLIP_BOX_PREFIX.test(t) || DATE_TIME_PREFIX.test(t);
}

export type FieldKind = 'none' | 'link' | 'invalid';

export interface SlipField {
	kind: FieldKind;
	/** Target title of the internal link, if kind === 'link'. */
	target?: string;
	/** Raw text captured after the `이전:`/`다음:` prefix, for diagnostics. */
	raw?: string;
}

export interface SlipNoteIssue {
	code: string;
	message: string;
}

export interface SlipNoteCheckResult {
	guid: string;
	title: string;
	issues: SlipNoteIssue[];
	prev?: SlipField;
	next?: SlipField;
}

export interface HeadEntry {
	section: SectionHeading;
	/** Title as stored in the index link; looked up via note title. */
	title: string;
}

export interface ChainNode {
	result: SlipNoteCheckResult;
	/** True for the first node in a chain (expected prev = none). */
	isHead: boolean;
	/** True for the last node reached in a chain (expected next = none). */
	isTail: boolean;
}

export interface ChainResult {
	head: HeadEntry;
	nodes: ChainNode[];
	/** Structural issues not tied to a single note (broken link, loop). */
	chainIssues: string[];
}

export interface ValidationSummary {
	indexFound: boolean;
	heads: HeadEntry[];
	chains: ChainResult[];
	/**
	 * Notes in the Slip-Box notebook that were never reached by any chain.
	 * They may be orphaned or linked only from outside the index.
	 */
	unreachableSlipBoxNotes: { guid: string; title: string; issues: SlipNoteIssue[] }[];
	/** Raw counts for the dashboard header. */
	stats: {
		slipBoxNotes: number;
		headsExtracted: number;
		notesValidated: number;
		notesWithIssues: number;
	};
}

// ─── Utilities ───────────────────────────────────────────────────────────

function getPlainText(node: JSONContent | undefined): string {
	if (!node) return '';
	if (typeof node.text === 'string') return node.text;
	if (!node.content) return '';
	return node.content.map(getPlainText).join('');
}

function paragraphInlines(node: JSONContent): JSONContent[] {
	return node.content ?? [];
}

function paragraphIsEmpty(node: JSONContent): boolean {
	const inlines = paragraphInlines(node);
	if (inlines.length === 0) return true;
	return inlines.every(
		(inl) => inl.type === 'text' && (inl.text ?? '').trim() === ''
	);
}

function internalLinkTarget(inline: JSONContent): string | undefined {
	if (inline.type !== 'text') return undefined;
	const mark = (inline.marks ?? []).find((m) => m.type === 'tomboyInternalLink');
	if (!mark) return undefined;
	const t = mark.attrs?.target;
	return typeof t === 'string' ? t : undefined;
}

// ─── Per-note format validation ──────────────────────────────────────────

/**
 * Parse the "이전:" / "다음:" paragraph. Returns the field's kind plus a
 * diagnostic message when the format is violated.
 */
function parsePrevNextParagraph(
	node: JSONContent,
	label: '이전' | '다음'
): { field: SlipField; error?: string } {
	if (node.type !== 'paragraph') {
		return { field: { kind: 'invalid' }, error: `${label} 줄이 단락이 아닙니다` };
	}
	const inlines = paragraphInlines(node);
	if (inlines.length === 0) {
		return { field: { kind: 'invalid' }, error: `${label} 줄이 비어 있습니다` };
	}

	const first = inlines[0];
	if (first.type !== 'text' || typeof first.text !== 'string') {
		return { field: { kind: 'invalid' }, error: `${label} 줄이 텍스트로 시작하지 않습니다` };
	}
	// The whole prefix must be in one text run so the link (if any) cleanly
	// follows. Accept a tolerant "${label}:" with optional whitespace around.
	const m = first.text.match(new RegExp(`^\\s*${label}\\s*:\\s*`));
	if (!m) {
		return {
			field: { kind: 'invalid' },
			error: `${label} 줄은 "${label}: "로 시작해야 합니다 (현재: "${first.text.slice(0, 20)}")`
		};
	}
	const afterPrefix = first.text.slice(m[0].length);

	// Case 1: single text run → must be empty or "없음".
	if (inlines.length === 1) {
		const trimmed = afterPrefix.trim();
		if (trimmed === '' || trimmed === '없음') {
			return { field: { kind: 'none', raw: trimmed } };
		}
		return {
			field: { kind: 'invalid', raw: afterPrefix },
			error: `${label} 값이 링크도 '없음'도 아닙니다: "${trimmed}"`
		};
	}

	// Case 2: more inlines → the text after the prefix must be empty (the
	// link starts immediately), and the *next* inline must be the internal
	// link. Anything past the link (other than whitespace) is a format error.
	if (afterPrefix.trim() !== '') {
		return {
			field: { kind: 'invalid', raw: afterPrefix },
			error: `${label} 뒤에 링크 외의 텍스트가 있습니다: "${afterPrefix.trim()}"`
		};
	}

	const second = inlines[1];
	const target = internalLinkTarget(second);
	if (!target) {
		return {
			field: { kind: 'invalid' },
			error: `${label} 뒤가 내부 링크가 아닙니다`
		};
	}

	// Extra content after the link? Only whitespace is allowed.
	for (let i = 2; i < inlines.length; i++) {
		const extra = inlines[i];
		if (extra.type === 'text' && (extra.text ?? '').trim() === '') continue;
		return {
			field: { kind: 'invalid', target, raw: second.text },
			error: `${label} 링크 뒤에 추가 내용이 있습니다`
		};
	}

	return { field: { kind: 'link', target, raw: second.text } };
}

/**
 * Validate a single note's slip-format. Does NOT check chain links — that
 * happens in `validateSlipBox`.
 */
export function validateSlipNoteFormat(note: NoteData): SlipNoteCheckResult {
	const issues: SlipNoteIssue[] = [];
	const doc = deserializeContent(note.xmlContent);
	const blocks = doc.content ?? [];

	if (blocks.length < 5) {
		issues.push({
			code: 'TOO_SHORT',
			message: `노트 블록이 5개 미만입니다 (현재 ${blocks.length}개)`
		});
		return { guid: note.guid, title: note.title, issues };
	}

	// [0] title
	if (blocks[0].type !== 'paragraph') {
		issues.push({
			code: 'TITLE_NOT_PARAGRAPH',
			message: '첫 블록이 텍스트 단락이 아닙니다'
		});
	} else {
		const titleText = getPlainText(blocks[0]).trim();
		if (titleText !== note.title.trim()) {
			issues.push({
				code: 'TITLE_MISMATCH',
				message: `첫 줄 텍스트가 제목과 다릅니다: "${titleText}" ≠ "${note.title}"`
			});
		}
	}

	// [1] blank line
	if (blocks[1].type !== 'paragraph' || !paragraphIsEmpty(blocks[1])) {
		issues.push({
			code: 'MISSING_BLANK_AFTER_TITLE',
			message: '제목 다음 줄은 공백이어야 합니다'
		});
	}

	// [2] 이전
	const prev = parsePrevNextParagraph(blocks[2], '이전');
	if (prev.error) {
		issues.push({ code: 'PREV_INVALID', message: prev.error });
	}

	// [3] 다음
	const next = parsePrevNextParagraph(blocks[3], '다음');
	if (next.error) {
		issues.push({ code: 'NEXT_INVALID', message: next.error });
	}

	// [4] blank line
	if (blocks[4].type !== 'paragraph' || !paragraphIsEmpty(blocks[4])) {
		issues.push({
			code: 'MISSING_BLANK_BEFORE_BODY',
			message: '다음 줄 아래는 공백이어야 합니다'
		});
	}

	return {
		guid: note.guid,
		title: note.title,
		issues,
		prev: prev.field,
		next: next.field
	};
}

// ─── Index extraction ────────────────────────────────────────────────────

/**
 * Walk the index note's content and collect all internal link targets found
 * inside the `이론` / `실용` / `기록` lists. A section ends at the next
 * section heading or any non-list block between sections.
 */
export function extractHeadsFromIndex(indexXml: string): HeadEntry[] {
	const doc = deserializeContent(indexXml);
	const blocks = doc.content ?? [];
	const heads: HeadEntry[] = [];

	let currentSection: SectionHeading | null = null;

	for (const block of blocks) {
		if (block.type === 'paragraph') {
			const t = getPlainText(block).trim();
			if ((SECTION_HEADINGS as readonly string[]).includes(t)) {
				currentSection = t as SectionHeading;
			}
			// Non-section paragraphs don't clear currentSection so a blank
			// paragraph between the heading and its list doesn't break us.
		} else if (block.type === 'bulletList') {
			if (!currentSection) continue;
			for (const target of collectInternalLinks(block)) {
				heads.push({ section: currentSection, title: target });
			}
			// A section's content is a single list; once consumed, clear the
			// pointer so later bulletLists (e.g. a future section we don't
			// recognise) don't inherit it.
			currentSection = null;
		}
	}

	// Dedupe on (section, title) — same link listed twice in the index would
	// otherwise double-visit the same chain.
	const seen = new Set<string>();
	return heads.filter((h) => {
		const key = h.section + '\0' + h.title.trim().toLocaleLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function collectInternalLinks(root: JSONContent): string[] {
	const out: string[] = [];
	const walk = (n: JSONContent) => {
		if (n.type === 'text') {
			const t = internalLinkTarget(n);
			if (t) out.push(t);
		}
		for (const c of n.content ?? []) walk(c);
	};
	walk(root);
	return out;
}

// ─── Chain traversal ─────────────────────────────────────────────────────

/**
 * End-to-end validation: load the index note, extract heads, walk each
 * chain, validate each visited note's format, and report unreachable
 * Slip-Box notes.
 */
export async function validateSlipBox(): Promise<ValidationSummary> {
	const allNotes = await getAllNotes();
	const slipBoxNotes = allNotes.filter((n) => getNotebook(n) === SLIPBOX_NOTEBOOK);

	const byTitle = new Map<string, NoteData>();
	for (const n of allNotes) {
		const key = n.title.trim().toLocaleLowerCase();
		if (!key) continue;
		// First-write-wins; listNotes-like descending-changeDate order is
		// preserved by getAllNotes so the freshest title match wins.
		if (!byTitle.has(key)) byTitle.set(key, n);
	}

	const indexNote = allNotes.find((n) => n.guid === INDEX_NOTE_GUID);
	if (!indexNote) {
		return {
			indexFound: false,
			heads: [],
			chains: [],
			unreachableSlipBoxNotes: [],
			stats: {
				slipBoxNotes: slipBoxNotes.length,
				headsExtracted: 0,
				notesValidated: 0,
				notesWithIssues: 0
			}
		};
	}

	const heads = extractHeadsFromIndex(indexNote.xmlContent).filter((h) =>
		isSlipNoteTitle(h.title)
	);

	const visitedGuids = new Set<string>();
	const chains: ChainResult[] = [];
	let notesValidated = 0;
	let notesWithIssues = 0;

	for (const head of heads) {
		const chain: ChainResult = { head, nodes: [], chainIssues: [] };

		const startKey = head.title.trim().toLocaleLowerCase();
		const startNote = byTitle.get(startKey);
		if (!startNote) {
			chain.chainIssues.push(`HEAD "${head.title}" 에 해당하는 노트를 찾을 수 없습니다`);
			chains.push(chain);
			continue;
		}

		let current: NoteData | undefined = startNote;
		let isHead = true;
		// Per-chain loop guard distinct from the global visitedGuids so
		// "already visited by a previous chain" reads differently from
		// "loops in this chain".
		const chainVisited = new Set<string>();

		while (current) {
			if (chainVisited.has(current.guid)) {
				chain.chainIssues.push(`순환 감지: "${current.title}" 을 이 체인에서 재방문`);
				break;
			}
			chainVisited.add(current.guid);

			if (visitedGuids.has(current.guid)) {
				chain.chainIssues.push(
					`"${current.title}" 은 다른 체인에서 이미 방문됨 (중복 HEAD 가능성)`
				);
				// Still validate — but don't re-count.
			}
			visitedGuids.add(current.guid);

			const result = validateSlipNoteFormat(current);
			notesValidated++;

			// Head / tail constraints on prev/next that the format validator
			// by itself can't know about.
			if (isHead && result.prev?.kind === 'link') {
				result.issues.push({
					code: 'HEAD_HAS_PREV_LINK',
					message: 'HEAD 노트이지만 "이전" 값이 링크입니다 ("없음" 또는 공백이어야 함)'
				});
			}

			if (result.issues.length > 0) notesWithIssues++;

			const nextField = result.next;
			const isTail = !nextField || nextField.kind !== 'link';
			chain.nodes.push({ result, isHead, isTail });

			if (!nextField || nextField.kind === 'invalid') break;
			if (nextField.kind === 'none') break;

			const nextTitle = (nextField.target ?? '').trim();
			if (!nextTitle) {
				chain.chainIssues.push(`"${current.title}" 의 다음 링크 target이 비어있습니다`);
				break;
			}
			// Non-slip-note titles terminate the chain silently — those
			// links may intentionally cross into free-form notes that we
			// don't enforce the format on.
			if (!isSlipNoteTitle(nextTitle)) break;
			const nextNote = byTitle.get(nextTitle.toLocaleLowerCase());
			if (!nextNote) {
				chain.chainIssues.push(
					`"${current.title}" → "${nextField.target}" : 다음 노트를 찾을 수 없습니다`
				);
				break;
			}
			current = nextNote;
			isHead = false;
		}

		chains.push(chain);
	}

	// Unreachable: Slip-Box notes we never visited while walking chains.
	const unreachableSlipBoxNotes = slipBoxNotes
		.filter((n) => !visitedGuids.has(n.guid) && n.guid !== INDEX_NOTE_GUID)
		.map((n) => {
			const r = validateSlipNoteFormat(n);
			notesValidated++;
			if (r.issues.length > 0) notesWithIssues++;
			return { guid: n.guid, title: n.title, issues: r.issues };
		});

	return {
		indexFound: true,
		heads,
		chains,
		unreachableSlipBoxNotes,
		stats: {
			slipBoxNotes: slipBoxNotes.length,
			headsExtracted: heads.length,
			notesValidated,
			notesWithIssues
		}
	};
}
