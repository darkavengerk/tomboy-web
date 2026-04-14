import * as THREE from 'three';

const MOVEMENT_KEYS = new Set([
	'keyw',
	'keya',
	'keys',
	'keyd',
	'space',
	'keyc',
	'shiftleft',
	'shiftright'
]);

/**
 * Game-style first-person fly camera.
 *
 * - Click the canvas to acquire pointer lock; ESC to release.
 * - Mouse: look around (yaw + pitch, 'YXZ' Euler order, pitch clamped).
 * - W/A/S/D: forward / left / back / right along the camera's facing direction,
 *   projected onto the world's XZ plane so forward-movement doesn't drift
 *   vertically when you're looking up or down.
 * - Space / C: up / down along world-Y.
 * - Shift: ×3 speed boost.
 *
 * Meant to replace 3d-force-graph's built-in TrackballControls. Disable those
 * via `graph.controls().enabled = false` before attaching this.
 */
export class FpsControls {
	private camera: THREE.Camera;
	private domElement: HTMLElement;
	private euler = new THREE.Euler(0, 0, 0, 'YXZ');
	private keys = new Set<string>();
	private velocity = new THREE.Vector3();
	private direction = new THREE.Vector3();
	private forward = new THREE.Vector3();
	private right = new THREE.Vector3();

	/** World units per second at normal speed. */
	speed = 120;
	/** Multiplier while Shift is held. */
	boost = 3;
	/** Radians per mouse pixel. */
	sensitivity = 0.002;

	private _locked = false;
	private _enabled = true;

	onLockChange?: (locked: boolean) => void;

	constructor(camera: THREE.Camera, domElement: HTMLElement) {
		this.camera = camera;
		this.domElement = domElement;
		// Initialize euler from current camera orientation so the first mouse
		// move doesn't snap the view.
		this.euler.setFromQuaternion(camera.quaternion);
		this.attach();
	}

	get locked() {
		return this._locked;
	}

	get enabled() {
		return this._enabled;
	}

	set enabled(value: boolean) {
		this._enabled = value;
		if (!value && this._locked) this.unlock();
	}

	/** Request pointer lock on the attached element. */
	lock() {
		if (!this._enabled) return;
		this.domElement.requestPointerLock?.();
	}

	unlock() {
		if (document.pointerLockElement === this.domElement) {
			document.exitPointerLock?.();
		}
	}

	update(deltaSeconds: number) {
		if (!this._enabled) return;
		if (!this._locked) return;

		const boost = this.keys.has('shiftleft') || this.keys.has('shiftright') ? this.boost : 1;
		const step = this.speed * boost * deltaSeconds;

		// Camera-relative forward projected to XZ (so pitching doesn't cause
		// up/down drift while moving "forward"); right is always horizontal.
		this.camera.getWorldDirection(this.forward);
		this.forward.y = 0;
		if (this.forward.lengthSq() === 0) this.forward.set(0, 0, -1);
		else this.forward.normalize();
		this.right.set(this.forward.z, 0, -this.forward.x); // rotate 90° around Y

		this.direction.set(0, 0, 0);
		if (this.keys.has('keyw')) this.direction.add(this.forward);
		if (this.keys.has('keys')) this.direction.sub(this.forward);
		if (this.keys.has('keyd')) this.direction.add(this.right);
		if (this.keys.has('keya')) this.direction.sub(this.right);
		if (this.keys.has('space')) this.direction.y += 1;
		if (this.keys.has('keyc')) this.direction.y -= 1;

		if (this.direction.lengthSq() > 0) {
			this.direction.normalize().multiplyScalar(step);
			this.camera.position.add(this.direction);
		}

		// Damp spurious velocity (future arrow-key support could use it).
		this.velocity.multiplyScalar(1 - Math.min(1, deltaSeconds * 10));
	}

	dispose() {
		this.detach();
	}

	// --- internals -----------------------------------------------------------

	private attach() {
		document.addEventListener('pointerlockchange', this.handleLockChange);
		document.addEventListener('mousemove', this.handleMouseMove);
		window.addEventListener('keydown', this.handleKeyDown);
		window.addEventListener('keyup', this.handleKeyUp);
		window.addEventListener('blur', this.handleBlur);
	}

	private detach() {
		document.removeEventListener('pointerlockchange', this.handleLockChange);
		document.removeEventListener('mousemove', this.handleMouseMove);
		window.removeEventListener('keydown', this.handleKeyDown);
		window.removeEventListener('keyup', this.handleKeyUp);
		window.removeEventListener('blur', this.handleBlur);
		if (this._locked) this.unlock();
	}

	private handleLockChange = () => {
		const locked = document.pointerLockElement === this.domElement;
		if (locked === this._locked) return;
		this._locked = locked;
		if (!locked) this.keys.clear();
		this.onLockChange?.(locked);
	};

	private handleMouseMove = (e: MouseEvent) => {
		if (!this._locked || !this._enabled) return;
		this.euler.y -= e.movementX * this.sensitivity;
		this.euler.x -= e.movementY * this.sensitivity;
		const limit = Math.PI / 2 - 0.001;
		if (this.euler.x > limit) this.euler.x = limit;
		if (this.euler.x < -limit) this.euler.x = -limit;
		this.camera.quaternion.setFromEuler(this.euler);
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		if (!this._locked) return;
		const code = e.code.toLowerCase();
		this.keys.add(code);
		// Space would otherwise scroll the page behind the locked canvas.
		if (MOVEMENT_KEYS.has(code)) e.preventDefault();
	};

	private handleKeyUp = (e: KeyboardEvent) => {
		this.keys.delete(e.code.toLowerCase());
	};

	private handleBlur = () => {
		this.keys.clear();
	};
}
