<!--
	Heads-up display overlay marking the aim point used for nearest-note /
	center-node calculations. `pointer-events: none` so it never eats canvas
	input. Stateless — caller just drops `<ReticleOverlay />` into the
	graph route.
-->

<div class="hud" aria-hidden="true">
	<svg class="reticle" viewBox="-20 -20 40 40">
		<circle cx="0" cy="0" r="7" />
		<circle cx="0" cy="0" r="1.2" />
		<line x1="-16" y1="0" x2="-10" y2="0" />
		<line x1="10" y1="0" x2="16" y2="0" />
		<line x1="0" y1="-16" x2="0" y2="-10" />
		<line x1="0" y1="10" x2="0" y2="16" />
	</svg>
</div>

<style>
	.hud {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 15;
	}

	.reticle {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 40px;
		height: 40px;
		transform: translate(-50%, -50%);
		stroke: rgba(230, 237, 243, 0.55);
		stroke-width: 1.2;
		fill: none;
		mix-blend-mode: screen;
	}

	.reticle circle:nth-child(2) {
		fill: rgba(230, 237, 243, 0.75);
		stroke: none;
	}
</style>
