// 로컬 확인용 빌드 전용 설정 — 배포에는 쓰지 않는다.
// 미디어 서버가 Ben_Claude/public/ 아래를 그대로 서빙하므로, 자산 절대경로(/_astro, /games)가
// 그 하위에서도 맞도록 base 를 미디어 URL 접두어로 잡는다. base 없이 복사하면 CSS·이미지가 전부 404.
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://virtual-in-playing.vercel.app',
  base: '/api/v1/media/0f6727b6-e24e-4ab5-b8c0-06c589f625de/public/playcast',
  output: 'static',
  build: { format: 'directory' },
  markdown: { shikiConfig: { theme: 'github-dark' } },
});
