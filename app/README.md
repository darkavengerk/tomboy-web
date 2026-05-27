# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.15.1 create --template minimal --types ts --install npm app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## 환경 변수

이미지 임시 저장소 (`/api/temp-image/*` Vercel 함수)에 필요한 환경 변수:

| 이름 | 용도 | 어디서 |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 스토어 접근 | Vercel 통합으로 자동 주입 (대시보드 → Storage → Blob 활성화) |
| `IMAGE_STORAGE_TOKEN` | `/api/temp-image/*` Bearer 시크릿. 앱 설정 페이지의 "이미지 서버 토큰"과 byte-identical하게 설정. | Vercel 대시보드 → Settings → Environment Variables. `openssl rand -hex 32` 같은 무작위 값 사용. |
