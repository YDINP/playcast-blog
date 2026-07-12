# Virtual in Playing (VIP) 🎀▶

**VIP(Virtual in Playing) — 버츄얼 호스트 로지가 게임을 "영상처럼" 소개하는 채널** — 유튜브 시청 페이지 UI 안에서
배경 크로스페이드 + 타이핑 자막 + 호스트 입모양 애니를 브라우저 타임라인으로 재생하는
**합성 씬플레이어(가짜 영상, 모션 블로그)**. 실제 영상 파일 0, 정적 배포, 생성비용 0.

**프로덕션: https://virtual-in-playing.vercel.app**

## 스택
Astro 5 (static) · 바닐라 씬플레이어 · 인라인 SVG 마스코트 · astro-og-canvas · Supabase 댓글

## 배포
GitHub `YDINP/playcast-blog` → Vercel 프로젝트 `virtual-in-playing` (Git 연동).
`master`에 push하면 프로덕션 자동 배포. 환경변수 없음.
> `vercel alias set`으로 도메인을 붙이면 특정 배포에 고정돼 다음 배포 때 SSO 302로 죽는다.
> 도메인 추가는 반드시 `vercel domains add <name>.vercel.app virtual-in-playing`.

## 개발
```bash
npm install
npm run dev -- --port 8008   # http://localhost:8008
npm run build                # dist/ 정적 산출물
```
> ⚠️ `astro preview`는 rest-route(`/watch/`) 정적 서빙 쿼크로 404가 날 수 있음.
> 로컬 확인은 `astro dev` 사용(Vercel 정적 호스팅은 물리 파일 매핑이라 정상).

## 콘텐츠 = 영상 한 편
`src/videos/*.md` frontmatter의 `scenes[]`가 SSOT. 각 씬:
```yaml
scenes:
  - text: "호스트 대사(=자막=트랜스크립트)"
    image: "/배경.jpg"          # 생략 시 그라디언트
    emotion: happy|surprised|think|idle
    chapter: "① 챕터명"          # 트랜스크립트/스크럽 라벨
    holdMs: 2000                 # 자막 후 정지(선택)
    voice: "/tts/scene1.mp3"     # TTS-ready(현재 미사용). 채우면 오디오에 립싱크
```

## 구조
- `public/js/scene-player.js` — 타임라인 엔진(시간 소스 추상화 → TTS-ready)
- `src/components/HostStage.astro` — 플레이어 DOM + 인라인 씬 JSON
- `src/components/HostMascot.astro` — SVG 로지(표정/입모양 CSS 토글)
- `src/pages/watch/[...slug].astro` — 유튜브 시청 페이지
- `src/pages/index.astro` — 채널 홈(히어로 미니플레이어 + 그리드)

자세한 기획: `PRD-playcast.md`
