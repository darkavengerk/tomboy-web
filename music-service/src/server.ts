import Fastify, { type FastifyInstance } from 'fastify';
import { extractBearer, verifyToken } from './auth.js';
import { extract as defaultExtract, type RunnerDeps } from './runner.js';

const MAX_BYTES = Number(process.env.MUSIC_MAX_REQUEST_BYTES ?? 64 * 1024);

export interface BuildServerOpts {
	sharedToken: string;
	bridgeFilesUrl: string;
	runnerOpts?: Partial<RunnerDeps>;
	// 테스트 주입용. 미지정 시 실제 yt-dlp 러너.
	extractFn?: (source: string) => Promise<{ url: string; title: string }>;
}

export function buildServer(opts: BuildServerOpts): FastifyInstance {
	const app = Fastify({ logger: true, bodyLimit: MAX_BYTES });
	const runExtract =
		opts.extractFn ??
		((source: string) =>
			defaultExtract(source, {
				bridgeFilesUrl: opts.bridgeFilesUrl,
				sharedToken: opts.sharedToken,
				...opts.runnerOpts
			}));

	app.post('/extract', async (req, reply) => {
		const token = extractBearer(req.headers.authorization);
		if (!verifyToken(opts.sharedToken, token)) return reply.code(401).send({ error: 'unauthorized' });
		const body = req.body as { source?: unknown } | undefined;
		if (!body || typeof body.source !== 'string' || !body.source) {
			return reply.code(400).send({ error: 'bad_request', detail: 'source required' });
		}
		try {
			const out = await runExtract(body.source);
			return reply.code(200).send(out);
		} catch (err) {
			const msg = (err as Error).message;
			const code = msg.startsWith('bad_source') ? 400 : msg === '타임아웃' ? 504 : 502;
			return reply.code(code).send({ error: code === 400 ? 'bad_source' : 'extract_failed', detail: msg });
		}
	});

	return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const sharedToken = process.env.BRIDGE_SHARED_TOKEN;
	if (!sharedToken) { console.error('BRIDGE_SHARED_TOKEN is required'); process.exit(1); }
	const bridgeFilesUrl = process.env.BRIDGE_FILES_URL;
	if (!bridgeFilesUrl) { console.error('BRIDGE_FILES_URL is required'); process.exit(1); }
	const runnerOpts: Partial<RunnerDeps> = {
		ytdlpPath: process.env.YTDLP_PATH,
		ffmpegPath: process.env.FFMPEG_PATH,
		maxFilesize: process.env.MUSIC_MAX_FILESIZE ?? '40M',
		timeoutMs: Number(process.env.MUSIC_TIMEOUT_MS ?? 180_000)
	};
	const port = Number(process.env.MUSIC_SERVICE_PORT ?? 7844);
	const app = buildServer({ sharedToken, bridgeFilesUrl, runnerOpts });
	app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`music-service on :${port}`));
}
