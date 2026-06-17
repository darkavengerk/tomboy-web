<!--
  집계 결과 막대 차트 — chart.js/auto 를 on-demand 로드(renderChart 재사용).
  정답(correctIndex)이 있으면 해당 막대를 초록으로. 득표가 바뀌면 통째로 재마운트
  (투표 빈도가 낮아 충분히 저렴). 컨테이너 ownerDocument 기반 teardown 으로 알려진
  'document is not defined' 플레이크 회피.
-->
<script lang="ts">
	import { mountChart, destroyChart, type ChartHandle } from '$lib/chart/renderChart';
	import type { TallyQuestion, QuestionResult } from '$lib/tally';

	let { question, result }: { question: TallyQuestion; result: QuestionResult } = $props();

	let container = $state<HTMLDivElement | undefined>();
	let handle: ChartHandle | null = null;

	const CORRECT = '#10b981';
	const NORMAL = '#3b82f6';

	$effect(() => {
		// 의존 추적: 득표 배열 내용 + 정답 위치 + 컨테이너.
		const counts = result.counts.slice();
		const correct = question.correctIndex;
		const labels = question.options.slice();
		const el = container;
		if (!el) return;

		let cancelled = false;
		(async () => {
			destroyChart(handle);
			handle = null;
			const config = {
				type: 'bar',
				data: {
					labels,
					datasets: [
						{
							label: '득표',
							data: counts,
							backgroundColor: labels.map((_, i) => (i === correct ? CORRECT : NORMAL)),
							borderRadius: 4,
							maxBarThickness: 56
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: { legend: { display: false }, tooltip: { enabled: true } },
					scales: {
						x: { grid: { display: false } },
						y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(0,0,0,0.06)' } }
					}
				}
			};
			const h = await mountChart(el, config, Math.max(140, labels.length * 28 + 60));
			if (cancelled) {
				destroyChart(h);
				return;
			}
			handle = h;
		})();

		return () => {
			cancelled = true;
			destroyChart(handle);
			handle = null;
		};
	});
</script>

<div class="tally-chart" bind:this={container}></div>

<style>
	.tally-chart {
		width: 100%;
		min-height: 140px;
	}
</style>
