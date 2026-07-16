# PRD — playcast: 유튜브형 "영상 블로그" (버츄얼 호스트 게임 소개)

> 상태: v1 스캐폴딩·시드 완료 (2026-07-10) · 별도 레포(gameflow 아님)

## 배경 / 목적

`gameflow-blog`(Astro 정적 게임 소개 텍스트 블로그)와 **같은 게임 소개 콘텐츠**를,
**유튜브 시청 페이지처럼 생긴 "가짜 영상(모션 블로그)"** 포맷으로 재구성한다.
버츄얼 호스트 마스코트 캐릭터가 게임을 소개하는 것처럼 보이는 화면.

- 실제 영상 파일 없음 → 씬 스크립트(배경 크로스페이드 + 타이핑 자막 + 호스트 입모양)를
  브라우저에서 타임라인으로 자동 재생 = **합성 씬플레이어**. 정적 배포, 생성비용 0.
- 무음(자막 중심, 입모양 토글, 선택적 효과음). 브라우저 자동재생 제약 없음.
- **TTS-ready**: 나중에 생성형 음성(mp3)만 씬 `voice`에 채우면 립싱크 동작(코드 변경 0).

## 핵심 결정 (사용자 확정)

| 항목 | 결정 |
|---|---|
| 영상 방식 | 합성 씬플레이어(가짜 영상) |
| 호스트 | 단일 마스코트 "로지(Rosie)" — 채널 얼굴 |
| 나레이션 | 무음 자막(입모양 토글) · TTS는 후속 |
| 레포명 | `playcast` (virtual-in-playing.vercel.app) |
| 호스트 렌더 | 인라인 SVG(표정/입모양 CSS 토글) — 외부 이미지 의존 0 |

## 아키텍처

Astro 정적 사이트. `gameflow-blog`의 배관(content collections, RSS, sitemap,
og-canvas, Supabase 댓글)만 재활용, 프레젠테이션은 전면 신규.

- **콘텐츠 모델**: `src/content.config.ts` `videos` 컬렉션. frontmatter `scenes[]`가 SSOT.
  각 씬 = `{ image?, text, emotion?, holdMs?, chapter?, voice? }`.
- **엔진**: `public/js/scene-player.js` (바닐라). 시간 소스를
  `_sceneElapsed()/_sceneDuration()/_typingDuration()`로 추상화 → voice 있으면
  오디오 시간에 자막·입모양 립싱크, 없으면 텍스트 길이 기반 가상 타임라인.
- **스테이지**: `HostStage.astro`(DOM 뼈대 + 인라인 씬 JSON) + `HostMascot.astro`(SVG 로지).
- **페이지**: `index`(채널 홈: 히어로 미니플레이어+칩+그리드), `watch/[...slug]`(시청 페이지),
  `about`(채널 소개), `rss.xml`, `open-graph/[...route]`(영상 썸네일풍 OG).
- **재사용**: `CommentSection.astro`(Supabase, source="playcast"로 분리).

## SEO / 접근성

- 씬 대사 전문 = watch 페이지 하단 **정적 트랜스크립트**로 렌더(크롤 가능, JS 없이도 콘텐츠 온전).
- `prefers-reduced-motion` → 자동재생 억제, 첫 씬 정지 + 트랜스크립트로 대체.
- 씬 JSON은 페이지 인라인(작은 페이로드) — 전체 콘텐츠 전역 인라인 금지(모바일 perf 교훈).

## 검증 결과 (v1)

- `npm run build` 무에러: 홈/about/watch 3편/OG 3장/rss/sitemap 생성.
- `astro dev`(8008) watch 200 + Playwright 스크린샷: 자동재생·타이핑·입모양·챕터 하이라이트 동작 확인.
- ⚠️ `astro preview`(정적 서버)는 rest-route(`/watch/`,`/open-graph/`) 404 쿼크 →
  Vercel 정적 호스팅은 물리 파일 직접 매핑이라 정상. 로컬 확인은 `astro dev` 사용.

## 후속 (범위 밖)

- 실제 게임 스크린샷/AI 배경을 씬 `image`에 채우기(현재 그라디언트 플레이스홀더).
- 호스트 AI 래스터 아트(현재 SVG로 충분).
- 생성형 TTS 음성 → 씬 `voice` 채우기(엔진/스키마 이미 완비).
- Vercel 배포, `og-default.png`, n8n 자동 포스팅, Supabase 댓글 테이블 source 확인.
