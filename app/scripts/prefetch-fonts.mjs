// 리마커블 PDF 송출에 쓰는 NanumGothic TTF 를 빌드 정적 자산으로 가져온다.
// `prebuild`/`predev` 에서 자동 실행 — 이미 받아 둔 파일이 있으면 skip.
//
// 폰트 출처: google/fonts (Apache-2.0 / OFL). NanumGothic 은 OFL.
// repo 에 commit 하지 않고 빌드 시 캐시한다 (`static/fonts/*.ttf` 는 .gitignore).

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const SOURCES = {
  'NanumGothic-Regular.ttf':
    'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Regular.ttf',
  'NanumGothic-Bold.ttf':
    'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf'
};

const OUT_DIR = new URL('../static/fonts/', import.meta.url);

await mkdir(OUT_DIR, { recursive: true });

let downloaded = 0;
let skipped = 0;
for (const [name, url] of Object.entries(SOURCES)) {
  const dst = new URL(name, OUT_DIR);
  if (existsSync(dst)) {
    skipped += 1;
    continue;
  }
  process.stdout.write(`↓ ${name} ... `);
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}`);
    console.error(
      `\nfont prefetch 실패: ${url}\n` +
        `네트워크가 닿지 않으면 위 URL 의 파일을 직접 ${OUT_DIR.pathname} 에 두세요.`
    );
    process.exit(1);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(dst, buf);
  console.log(`${buf.length.toLocaleString()} bytes`);
  downloaded += 1;
}

console.log(`fonts: ${downloaded} downloaded, ${skipped} already present`);
