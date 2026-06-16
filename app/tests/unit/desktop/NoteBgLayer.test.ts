import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import NoteBgLayer from '$lib/desktop/NoteBgLayer.svelte';

afterEach(cleanup);

describe('NoteBgLayer', () => {
	it('renders a bg layer carrying the mode + image url, hidden from a11y', () => {
		const { container } = render(NoteBgLayer, { props: { url: 'blob:abc', mode: 'cover' } });
		const el = container.querySelector('.note-bg-layer') as HTMLElement;
		expect(el).toBeTruthy();
		expect(el.getAttribute('data-bg-mode')).toBe('cover');
		expect(el.style.backgroundImage).toContain('blob:abc');
		expect(el.getAttribute('aria-hidden')).toBe('true');
	});

	it('reflects an explicit opacity prop', () => {
		const { container } = render(NoteBgLayer, {
			props: { url: 'blob:x', mode: 'tile', opacity: 0.4 }
		});
		const el = container.querySelector('.note-bg-layer') as HTMLElement;
		expect(el.style.opacity).toBe('0.4');
	});

	it('defaults opacity to fully opaque', () => {
		const { container } = render(NoteBgLayer, { props: { url: 'blob:x', mode: 'fill' } });
		const el = container.querySelector('.note-bg-layer') as HTMLElement;
		expect(el.style.opacity).toBe('1');
	});
});
