# PRD — VIP 자막 핵심어 강조 (subtitle emphasis)

## 배경 / 문제
- 포스팅 상세 내용은 **씬 자막**으로 읽히는데, 자막은 `textContent` 순수 텍스트라
  핵심어 강조가 불가능(별표 그대로 노출됨).
- 본문 마크다운의 `**볼드**`(AI 강조어법)는 watch 페이지에서 **렌더되지 않음** → 강조 의도가 사라짐.
- 목표: AI스러운 검정 볼드 대신, 자막 내 핵심어를 **브랜드 민트(--host)** 로 편집 강조.

## 목표
- 씬 `text`에 `**키워드**` 표기 → 자막에서 민트 강조로 렌더(타이핑 리빌 유지).
- 정적/무JS/SEO에서도 첫 씬 강조 노출. `**` 마커는 길이·SEO·타이밍 계산에서 제외.

## 범위 (파일)
1. `src/lib/video.ts` — `parseEmphasis()`, `stripEmphasis()` 추가 + `estimateSeconds` 길이 보정
2. `src/components/HostStage.astro` — 첫 씬 text를 강조 세그먼트로 렌더(SSR/SEO)
3. `src/pages/watch/[...slug].astro` — articleBody(SEO)·chapter label 폴백에서 마커 제거
4. `public/js/scene-player.js` — `**` 파서 + `innerHTML` 리빌, 타이밍은 plain 길이
5. `src/styles/global.css` — `.sp-em` 스타일(민트 + 굵기 + 은은한 글로우)
6. (적용) `src/videos/2026-07-16-digimon-up-announced.md` 씬 핵심어에 `**` 부여(시연/즉시 적용)

## 비범위
- 본문 프로즈를 페이지에 렌더(선택지 B) — 이번 제외
- 타 포스팅 일괄 적용 — 요청 시 후속 배치

## 검증
- dev(8008) digimon watch: 자막 타이핑 중/완료 시 강조어가 민트로 렌더, 별표 미노출
- 총 재생시간·장면수 표시가 마커 영향 없음
- reduced-motion / 정적 첫 씬에서도 강조 노출
