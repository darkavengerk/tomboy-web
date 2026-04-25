import type { ScheduleItem } from './buildScheduleItem.js';

export interface ScheduleDiff {
	added: ScheduleItem[];
	removed: ScheduleItem[];
}

/**
 * Compute the set difference of two schedule item lists by `id`.
 * - `added`: ids present in `curr` but not in `prev`.
 * - `removed`: ids present in `prev` but not in `curr`.
 * Duplicates in either input are deduped (first occurrence wins).
 */
export function diffSchedules(
	prev: ScheduleItem[],
	curr: ScheduleItem[]
): ScheduleDiff {
	const prevMap = new Map<string, ScheduleItem>();
	for (const it of prev) if (!prevMap.has(it.id)) prevMap.set(it.id, it);
	const currMap = new Map<string, ScheduleItem>();
	for (const it of curr) if (!currMap.has(it.id)) currMap.set(it.id, it);

	const added: ScheduleItem[] = [];
	for (const [id, it] of currMap) {
		if (!prevMap.has(id)) added.push(it);
	}
	const removed: ScheduleItem[] = [];
	for (const [id, it] of prevMap) {
		if (!currMap.has(id)) removed.push(it);
	}
	return { added, removed };
}
