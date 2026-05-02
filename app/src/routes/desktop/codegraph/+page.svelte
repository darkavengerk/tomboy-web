<script lang="ts">
	import { onMount } from 'svelte';
	import { loadCodegraphData } from '$lib/codegraph/loadCodegraphData.js';
	import type {
		CodegraphData,
		CodegraphLink,
		CodegraphNode,
		LoadResult
	} from '$lib/codegraph/codegraphTypes.js';
	import { nodeColor } from '$lib/codegraph/nodeColor.js';
	import { edgeStyle } from '$lib/codegraph/edgeStyle.js';
	import { FpsControls } from '$lib/desktop/graphCommon/FpsControls.js';
	import {
		updateLabelOpacity,
		type LabelEntry
	} from '$lib/desktop/graphCommon/labelLod.js';
	import {
		findCenterNode,
		findAimedNode
	} from '$lib/desktop/graphCommon/selectionPickers.js';
	import {
		createSelectionHalo,
		createHoverHalo,
		applyPulse,
		PULSE_DURATION_MS
	} from '$lib/desktop/graphCommon/haloFactory.js';
	import ReticleOverlay from '$lib/desktop/graphCommon/ReticleOverlay.svelte';
	import CodeNodePanel from '$lib/desktop/components/CodeNodePanel.svelte';
	import type { ForceGraph3DInstance } from '3d-force-graph';

	const SWITCH_DEBOUNCE_MS = 350;

	type LoadState =
		| { kind: 'loading' }
		| { kind: 'error'; reason: 'missing' | 'malformed' | 'network' | 'empty' | 'webgl'; detail?: string }
		| { kind: 'ready'; data: CodegraphData };

	let container: HTMLDivElement;
	let loadState = $state<LoadState>({ kind: 'loading' });
	let fpsLocked = $state(false);

	let selectedId = $state<string | null>(null);
	let panelOpen = $state(true);
	let selectMode = $state<'aim' | 'center'>('aim');

	let labelBaseDistance = $state(400);
	let nodeSpacing = $state(500);
	let moveSpeed = $state(60);
	let showLinks = $state(true);

	let fg: ForceGraph3DInstance | null = null;
	let fpsRef: FpsControls | null = null;
	let disposed = false;

	let flyToNode: ((id: string) => void) | null = null;

	const data = $derived(loadState.kind === 'ready' ? loadState.data : null);
	const selectedNode = $derived.by((): CodegraphNode | null => {
		if (!data || !selectedId) return null;
		return data.nodes.find((n) => n.id === selectedId) ?? null;
	});
	const syncedLabel = $derived.by((): string => {
		if (!data) return '';
		try {
			return new Date(data.meta.syncedAt).toLocaleString('ko-KR');
		} catch {
			return data.meta.syncedAt;
		}
	});

	onMount(() => {
		let cleanup: (() => void) | null = null;
		(async () => {
			const result: LoadResult = await loadCodegraphData();
			if (disposed) return;
			if (!result.ok) {
				loadState = { kind: 'error', reason: result.reason, detail: result.detail };
				return;
			}
			if (result.data.nodes.length === 0) {
				loadState = { kind: 'error', reason: 'empty' };
				return;
			}
			loadState = { kind: 'ready', data: result.data };
			try {
				cleanup = await initGraph(result.data);
			} catch (err) {
				console.error('[codegraph] init failed', err);
				if (!disposed) {
					loadState = { kind: 'error', reason: 'webgl' };
				}
			}
		})();
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	async function initGraph(graphData: CodegraphData): Promise<() => void> {
		const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
			import('3d-force-graph'),
			import('three'),
			import('three-spritetext')
		]);

		if (disposed) return () => {};

		const labelEntries: LabelEntry[] = [];
		const isHubLabel = (size: number) => size >= 1.6;

		// Format an EdgeColor as "rgba(...)" for 3d-force-graph's linkColor.
		const linkColorCache = new Map<string, string>();
		function colorForLink(l: CodegraphLink): string {
			const key = `${l.relation}|${l.confidence}`;
			let cached = linkColorCache.get(key);
			if (cached) return cached;
			const c = edgeStyle(l.relation, l.confidence);
			cached = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a.toFixed(3)})`;
			linkColorCache.set(key, cached);
			return cached;
		}

		const graph = new ForceGraph3D(container, { controlType: 'orbit' })
			.enableNavigationControls(false)
			.backgroundColor('#05060a')
			.nodeRelSize(4)
			.nodeLabel((n) => (n as CodegraphNode).title)
			.linkColor((l) => colorForLink(l as unknown as CodegraphLink))
			.linkDirectionalArrowLength(0)
			.linkWidth(0.3)
			.linkOpacity(1)
			.cooldownTicks(200)
			.warmupTicks(40)
			.d3AlphaDecay(0.05)
			.d3VelocityDecay(0.3)
			.nodeThreeObject((raw) => {
				const node = raw as CodegraphNode;
				const group = new THREE.Group();
				const radius = 3 * node.size;
				const color = new THREE.Color(nodeColor(node.community));
				const sphere = new THREE.Mesh(
					new THREE.SphereGeometry(radius, 24, 16),
					new THREE.MeshBasicMaterial({ color })
				);
				group.add(sphere);

				const label = new SpriteText(node.title);
				label.color = '#ffffff';
				label.textHeight = 4 * node.size;
				label.backgroundColor = 'rgba(0,0,0,0.45)';
				label.padding = 1;
				label.position.set(0, radius + 2 + label.textHeight / 2, 0);
				group.add(label);

				const hub = isHubLabel(node.size);
				if (hub) {
					label.visible = true;
				} else {
					label.material.transparent = true;
					label.material.opacity = 0;
					label.visible = false;
				}
				labelEntries.push({
					node: node as CodegraphNode & { x?: number; y?: number; z?: number },
					label: label as LabelEntry['label'],
					isHub: hub
				});
				return group;
			})
			.nodeThreeObjectExtend(false)
			.graphData(graphData);

		fg = graph;

		const camera = graph.camera();
		const renderer = graph.renderer();
		const fps = new FpsControls(camera, renderer.domElement);
		fps.speed = moveSpeed;
		fpsRef = fps;
		fps.onLockChange = (locked) => {
			fpsLocked = locked;
		};

		const canvasEl = renderer.domElement;
		const handleCanvasClick = () => {
			if (!fps.locked) {
				fps.lock();
				return;
			}
			const id = pickCenter();
			if (id) {
				panelOpen = true;
				selectMode = 'center';
				candidateId = id;
				candidateSince = performance.now();
				selectedId = id;
				triggerClickPulse();
			}
		};
		canvasEl.addEventListener('click', handleCanvasClick);

		const MOVEMENT_KEYS_FOR_MODE = new Set([
			'keyw', 'keya', 'keys', 'keyd', 'space', 'keyc'
		]);
		const onMovementKey = (e: KeyboardEvent) => {
			const code = e.code.toLowerCase();
			if (!MOVEMENT_KEYS_FOR_MODE.has(code)) return;
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.isContentEditable)
			) {
				return;
			}
			selectMode = 'aim';
			if (!fps.locked) fps.lock();
		};
		window.addEventListener('keydown', onMovementKey);

		const selectionHalo = createSelectionHalo();
		const halo = selectionHalo.mesh;
		graph.scene().add(halo);

		const hoverHaloHandle = createHoverHalo();
		const hoverHalo = hoverHaloHandle.mesh;
		graph.scene().add(hoverHalo);

		const liveNodes = graph.graphData().nodes as Array<
			CodegraphNode & { x?: number; y?: number; z?: number }
		>;
		const liveNodesById = new Map<
			string,
			CodegraphNode & { x?: number; y?: number; z?: number }
		>();
		for (const n of liveNodes) liveNodesById.set(n.id, n);

		let pulseUntil = 0;
		function triggerClickPulse() {
			pulseUntil = performance.now() + PULSE_DURATION_MS;
		}

		const centerScratch = { ndc: new THREE.Vector3() };
		const aimedScratch = {
			forward: new THREE.Vector3(),
			tmpPoint: new THREE.Vector3(),
			frustum: new THREE.Frustum(),
			projMatrix: new THREE.Matrix4()
		};
		const rendererSize = { width: 0, height: 0 };
		const pickCenter = () => {
			rendererSize.width = graph.width();
			rendererSize.height = graph.height();
			return findCenterNode(liveNodes, camera, rendererSize, centerScratch);
		};
		const pickAimed = () => findAimedNode(liveNodes, camera, aimedScratch);

		function haloRadiusFor(size: number): number {
			return 3 * size;
		}

		function updateHalo(t: number) {
			if (!selectedId) {
				halo.visible = false;
				return;
			}
			const n = liveNodesById.get(selectedId);
			if (!n || n.x === undefined) {
				halo.visible = false;
				return;
			}
			halo.visible = true;
			halo.position.set(n.x, n.y ?? 0, n.z ?? 0);
			halo.lookAt(camera.position);
			const baseRadius = haloRadiusFor(n.size);
			applyPulse(halo, baseRadius, t, pulseUntil);
			halo.rotateZ(0.008);
		}

		function updateLabelVisibility() {
			updateLabelOpacity(
				labelEntries,
				camera.position.x,
				camera.position.y,
				camera.position.z,
				labelBaseDistance
			);
		}

		let currentCenterId: string | null = null;

		function updateHoverHalo() {
			const id = pickCenter();
			currentCenterId = id;
			if (!id || id === selectedId) {
				hoverHalo.visible = false;
				return;
			}
			const n = liveNodesById.get(id);
			if (!n || n.x === undefined) {
				hoverHalo.visible = false;
				return;
			}
			hoverHalo.visible = true;
			hoverHalo.position.set(n.x, n.y ?? 0, n.z ?? 0);
			hoverHalo.lookAt(camera.position);
			hoverHalo.scale.setScalar(haloRadiusFor(n.size));
		}

		type LinkObj = {
			source: string | { id?: string };
			target: string | { id?: string };
			__lineObj?: { visible: boolean };
			__arrowObj?: { visible: boolean };
		};
		function linkEndpointId(v: LinkObj['source']): string {
			return typeof v === 'string' ? v : v?.id ?? '';
		}
		function updateLinkVisibility() {
			const links = graph.graphData().links as unknown as LinkObj[];
			const show = showLinks;
			const sel = selectedId;
			const hov = currentCenterId;
			for (let i = 0; i < links.length; i++) {
				const l = links[i];
				let visible = false;
				if (show) {
					const sId = linkEndpointId(l.source);
					const tId = linkEndpointId(l.target);
					if (sId === sel || tId === sel) {
						visible = true;
					} else if (sId === hov || tId === hov) {
						visible = true;
					} else {
						const sn = liveNodesById.get(sId);
						const tn = liveNodesById.get(tId);
						if ((sn && sn.size >= 1.6) || (tn && tn.size >= 1.6)) {
							visible = true;
						}
					}
				}
				if (l.__lineObj && l.__lineObj.visible !== visible) {
					l.__lineObj.visible = visible;
				}
				if (l.__arrowObj && l.__arrowObj.visible !== visible) {
					l.__arrowObj.visible = visible;
				}
			}
		}

		let lastHaloedId: string | null = null;
		function maybePulseOnSelectionChange() {
			if (selectedId !== lastHaloedId) {
				lastHaloedId = selectedId;
				if (selectedId) triggerClickPulse();
			}
		}

		let candidateId: string | null = null;
		let candidateSince = 0;

		function updateNearest(now: number) {
			if (!panelOpen) return;
			const bestId = selectMode === 'center' ? pickCenter() : pickAimed();
			if (bestId === null) return;
			if (bestId !== candidateId) {
				candidateId = bestId;
				candidateSince = now;
			} else if (
				bestId !== selectedId &&
				now - candidateSince >= SWITCH_DEBOUNCE_MS
			) {
				selectedId = bestId;
			}
		}

		flyToNode = (id: string) => {
			const target = liveNodesById.get(id);
			if (!target || target.x === undefined) return;
			const distance = 80;
			const tx = target.x;
			const ty = target.y ?? 0;
			const tz = target.z ?? 0;
			const distRatio = 1 + distance / Math.hypot(tx, ty, tz || 1);
			graph.cameraPosition(
				{ x: tx * distRatio, y: ty * distRatio, z: tz * distRatio },
				{ x: tx, y: ty, z: tz },
				1000
			);
		};

		let lastTime = performance.now();
		let rafId = 0;
		const loop = (t: number) => {
			const dt = Math.min(0.1, (t - lastTime) / 1000);
			lastTime = t;
			fps.update(dt);
			updateNearest(t);
			maybePulseOnSelectionChange();
			updateHalo(t);
			updateHoverHalo();
			updateLinkVisibility();
			updateLabelVisibility();
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);

		return () => {
			cancelAnimationFrame(rafId);
			window.removeEventListener('keydown', onMovementKey);
			canvasEl.removeEventListener('click', handleCanvasClick);
			selectionHalo.dispose();
			hoverHaloHandle.dispose();
			fps.dispose();
			fpsRef = null;
			flyToNode = null;
			graph._destructor();
		};
	}

	function applyNodeSpacing(graph: ForceGraph3DInstance, magnitude: number) {
		const charge = graph.d3Force('charge') as
			| { strength?: (v: number) => unknown }
			| null
			| undefined;
		if (!charge || typeof charge.strength !== 'function') return;
		charge.strength(-magnitude);
		try {
			const reheat = (graph as unknown as { d3ReheatSimulation?: () => void })
				.d3ReheatSimulation;
			if (typeof reheat === 'function') reheat.call(graph);
		} catch {
			// Layout not ready yet — next tick will pick up the new strength.
		}
	}

	function reenablePanel() {
		panelOpen = true;
		selectMode = 'aim';
	}

	function handleNeighborClick(id: string) {
		if (flyToNode) flyToNode(id);
		selectedId = id;
		selectMode = 'aim';
	}

	$effect(() => {
		const s = nodeSpacing;
		if (!fg) return;
		applyNodeSpacing(fg, s);
	});

	$effect(() => {
		const v = moveSpeed;
		if (fpsRef) fpsRef.speed = v;
	});

	$effect(() => {
		if (!fg || !container) return;
		const instance = fg;
		const el = container;
		const resize = () => {
			instance.width(el.clientWidth).height(el.clientHeight);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		return () => ro.disconnect();
	});

	function truncate(s: string | undefined, n: number): string {
		if (!s) return '';
		return s.length > n ? s.slice(0, n) + '…' : s;
	}
</script>

<svelte:head>
	<title>코드 그래프 — Tomboy Web</title>
</svelte:head>

<div class="codegraph-page">
	<div class="canvas" bind:this={container}></div>

	{#if loadState.kind === 'ready'}
		<div class="top-bar">
			<a class="back" href="/desktop" title="데스크톱으로 돌아가기">← 데스크톱</a>
			<label class="num-input" title="이 거리 이내면 라벨이 선명하게, 거리의 2배 범위까지 흐릿하게 표시됩니다.">
				라벨 거리
				<input type="number" bind:value={labelBaseDistance} min="50" step="50" />
			</label>
			<label class="num-input" title="노드 간 반발력. 값이 클수록 노드들이 더 넓게 퍼집니다.">
				노드 간격
				<input type="number" bind:value={nodeSpacing} min="5" step="5" />
			</label>
			<label class="num-input" title="WASD 이동 속도 (초당 월드 유닛). Shift로 3배 부스트.">
				이동 속도
				<input type="number" bind:value={moveSpeed} min="20" step="20" />
			</label>
			<label class="check-input" title="허브, 선택, 레티클 노드의 링크만 표시.">
				<input type="checkbox" bind:checked={showLinks} />
				링크 표시
			</label>
			{#if !panelOpen}
				<button type="button" class="auto-btn" onclick={reenablePanel}>자동 선택 다시 켜기</button>
			{/if}
			<div class="meta-info">
				<span class="synced">synced {syncedLabel}</span>
				<span class="counts">{data?.nodes.length.toLocaleString('ko-KR')} 노드 / {data?.links.length.toLocaleString('ko-KR')} 링크</span>
			</div>
		</div>

		<ReticleOverlay />

		<div class="fps-hint" class:paused={!fpsLocked}>
			{#if fpsLocked}
				WASD: 이동 · Space/C: 상/하 · Shift: 빠르게 · ESC: 정지
			{:else}
				클릭 또는 WASD 로 이동 시작
			{/if}
		</div>

		<CodeNodePanel
			open={panelOpen}
			selected={selectedNode}
			data={data}
			onclose={() => (panelOpen = false)}
			onneighborclick={handleNeighborClick}
		/>
	{:else if loadState.kind === 'loading'}
		<div class="status-overlay">
			<div class="loading-text">그래프 로딩 중…</div>
		</div>
	{:else}
		<div class="status-overlay">
			<div class="status-card">
				{#if loadState.reason === 'missing'}
					<h2>graphify가 아직 실행되지 않았습니다</h2>
					<pre class="cmd">/graphify app/src</pre>
					<pre class="cmd">npm run codegraph:sync</pre>
					<p>코드 그래프 데이터를 만들려면 위 두 명령을 순서대로 실행하세요.</p>
				{:else if loadState.reason === 'malformed'}
					<h2>데이터를 읽을 수 없습니다</h2>
					{#if loadState.detail}
						<p class="detail">{truncate(loadState.detail, 200)}</p>
					{/if}
				{:else if loadState.reason === 'network'}
					<h2>네트워크 오류</h2>
					{#if loadState.detail}
						<p class="detail">{truncate(loadState.detail, 200)}</p>
					{/if}
				{:else if loadState.reason === 'empty'}
					<h2>그래프가 비어있습니다 — graphify 실행 결과를 확인하세요</h2>
				{:else if loadState.reason === 'webgl'}
					<h2>WebGL을 초기화할 수 없습니다 — 브라우저/GPU 설정을 확인하세요</h2>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.codegraph-page {
		position: fixed;
		inset: 0;
		background: #05060a;
		color: #e6edf3;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		overflow: hidden;
	}

	.canvas {
		position: absolute;
		inset: 0;
	}

	.top-bar {
		position: absolute;
		top: 12px;
		left: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		gap: 12px;
		z-index: 10;
		pointer-events: none;
	}

	.top-bar > * {
		pointer-events: auto;
	}

	.back {
		color: #cfd8e3;
		text-decoration: none;
		padding: 6px 10px;
		border-radius: 4px;
		background: rgba(20, 24, 34, 0.75);
		border: 1px solid #2a3040;
		font-size: 0.85rem;
	}

	.back:hover {
		background: rgba(40, 50, 70, 0.85);
	}

	.num-input {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid #2a3040;
		background: rgba(20, 24, 34, 0.75);
		color: #cfd8e3;
		font-size: 0.78rem;
	}

	.num-input input {
		width: 64px;
		padding: 2px 4px;
		border-radius: 3px;
		border: 1px solid #2a3040;
		background: #0d1018;
		color: #e6edf3;
		font-size: 0.78rem;
		text-align: right;
	}

	.num-input input:focus {
		outline: none;
		border-color: #5a9;
	}

	.check-input {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid #2a3040;
		background: rgba(20, 24, 34, 0.75);
		color: #cfd8e3;
		font-size: 0.78rem;
		cursor: pointer;
		user-select: none;
	}

	.check-input input {
		accent-color: #4fd1c5;
		cursor: pointer;
	}

	.auto-btn {
		padding: 6px 12px;
		border-radius: 4px;
		border: 1px solid #3a5a7a;
		background: #1f2a3a;
		color: #cfd8e8;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.auto-btn:hover {
		background: #2d3d50;
	}

	.meta-info {
		margin-left: auto;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		padding: 4px 10px;
		border-radius: 4px;
		background: rgba(20, 24, 34, 0.6);
		font-size: 0.72rem;
		color: #8a94a6;
	}

	.fps-hint {
		position: absolute;
		top: 54px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 12px;
		background: rgba(20, 24, 34, 0.85);
		border: 1px solid #2a3040;
		border-radius: 4px;
		font-size: 0.78rem;
		color: #cfd8e3;
		z-index: 10;
		pointer-events: none;
	}

	.fps-hint:empty {
		display: none;
	}

	.fps-hint.paused {
		border-color: #5ab378;
		color: #cfe8d8;
		background: rgba(20, 46, 30, 0.85);
		animation: hint-pulse 1.8s ease-in-out infinite;
	}

	@keyframes hint-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(90, 179, 120, 0.0); }
		50% { box-shadow: 0 0 18px 2px rgba(90, 179, 120, 0.35); }
	}

	.status-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #05060a;
		z-index: 30;
	}

	.loading-text {
		color: #8a94a6;
		font-size: 0.9rem;
	}

	.status-card {
		max-width: 540px;
		padding: 24px 28px;
		background: #14182a;
		border: 1px solid #2a3040;
		border-radius: 8px;
		color: #e6edf3;
	}

	.status-card h2 {
		margin: 0 0 12px;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.status-card p {
		margin: 8px 0 0;
		font-size: 0.85rem;
		color: #cfd8e3;
		line-height: 1.5;
	}

	.status-card p.detail {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.78rem;
		color: #b0bccd;
		word-break: break-word;
	}

	.cmd {
		display: block;
		margin: 6px 0;
		padding: 8px 10px;
		background: #0d1018;
		border: 1px solid #2a3040;
		border-radius: 4px;
		color: #cfe8d8;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.82rem;
		white-space: pre;
		overflow-x: auto;
	}
</style>
