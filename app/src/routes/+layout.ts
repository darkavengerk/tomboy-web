// SvelteKit: prerender every page + render client-side only (SPA).
// /api/* routes opt out per-route via `export const prerender = false`
// and run as Vercel functions.
export const prerender = true;
export const ssr = false;
