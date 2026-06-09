/**
 * pdfmake 는 자체 d.ts 를 제공하지 않는다. 우리 어댑터가 필요한 최소 표면만
 * 선언 — 더 풍부한 타입이 필요해지면 `@types/pdfmake` 검토.
 */
declare module 'pdfmake/build/pdfmake' {
	interface PdfMake {
		vfs?: Record<string, string>;
		fonts?: Record<string, unknown>;
		createPdf(doc: unknown): { getBlob(cb: (blob: Blob) => void): void };
	}
	const pdfMake: PdfMake;
	export default pdfMake;
}
