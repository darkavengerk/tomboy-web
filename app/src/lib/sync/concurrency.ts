/**
 * Bounded-parallelism helpers for sync. Both use a worker-pool pattern so
 * peak in-flight is strictly ≤ limit.
 *
 *   runWithConcurrency           — fail-fast. On first rejection, drains the
 *                                  queue so no new tasks start, waits for
 *                                  in-flight to settle, then throws. Used by
 *                                  commitRevision's upload step so the caller
 *                                  never proceeds to the manifest write after
 *                                  a partial failure.
 *   runAllSettledWithConcurrency — collects every outcome. Used for
 *                                  downloads, where per-note failures are
 *                                  reported but the rest of the sync proceeds.
 */

export async function runWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	limit: number
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	const errors: unknown[] = [];
	let next = 0;
	const effective = Math.max(1, Math.min(limit, tasks.length));

	async function worker() {
		while (true) {
			const i = next++;
			if (i >= tasks.length) return;
			try {
				results[i] = await tasks[i]();
			} catch (err) {
				errors.push(err);
				next = tasks.length; // drain — other workers exit without starting new work
				return;
			}
		}
	}

	const workers = Array.from({ length: effective }, () => worker());
	await Promise.all(workers);
	if (errors.length > 0) throw errors[0];
	return results;
}

export async function runAllSettledWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	limit: number
): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = new Array(tasks.length);
	let next = 0;
	const effective = Math.max(1, Math.min(limit, Math.max(1, tasks.length)));

	async function worker() {
		while (true) {
			const i = next++;
			if (i >= tasks.length) return;
			try {
				results[i] = { status: 'fulfilled', value: await tasks[i]() };
			} catch (reason) {
				results[i] = { status: 'rejected', reason };
			}
		}
	}

	const workers = Array.from({ length: effective }, () => worker());
	await Promise.all(workers);
	return results;
}
