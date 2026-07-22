import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

// 글 하나 = "영상 한 편". frontmatter의 scenes 배열이 씬플레이어 타임라인의 SSOT.
const videos = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/videos' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    category: z.string(), // 코너/장르: Free, Indie, Review, Guide ...
    tags: z.array(z.string()),
    host: z.string().default('rosie'), // 마스코트 id (public/host/<id> 또는 기본 SVG)
    thumbnail: z.string().optional(), // 채널 홈 카드 썸네일 (미지정 시 첫 씬 image)
    customThumb: z.boolean().default(false), // true면 카드 자동 로지 합성 끔(썸네일에 로지가 이미 그려진 경우)
    // 대표 이미지 출처(인용 요건: 출처표기). 공식 프레스킷/스팀 등 사용 시 채움.
    imageCredit: z
      .object({
        text: z.string(), // 예: "© Rockstar Games (프레스킷)"
        url: z.string().optional(), // 출처 링크
      })
      .optional(),
    // 관련 상품(쿠팡 파트너스). 게임 기프트카드·게임기·게이밍 기어 등. 시청페이지 '관련 상품' 섹션에 렌더.
    // desc = 아이템 추천 설명(왜 이 글 독자에게 좋은지).
    coupang: z
      .array(z.object({ title: z.string(), desc: z.string().optional(), url: z.string() }))
      .optional(),
    // 자주 묻는 질문(FAQ). 시청페이지에 FAQ 섹션 + FAQPage 구조화데이터로 렌더.
    // 인접 검색쿼리(출시일/시간/다운로드 등) 포획 + 리치결과 노출용.
    faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
    durationLabel: z.string().optional(), // 표시용 "3:24" (미지정 시 씬 합산 자동)
    views: z.number().default(0), // 표시용 조회수 시드
    // 광고 표시 여부. 공식 게임 이미지를 쓰는 글은 인용 근거 강화를 위해 false 권장.
    ads: z.boolean().default(true),
    scenes: z
      .array(
        z.object({
          image: z.string().optional(), // 배경 스크린샷/일러스트 (없으면 그라디언트)
          text: z.string(), // 호스트 대사 = 자막 = 트랜스크립트 (SSOT)
          emotion: z.enum(['idle', 'happy', 'surprised', 'think']).optional(),
          holdMs: z.number().optional(), // 자막 완료 후 정지 override
          chapter: z.string().optional(), // 챕터 라벨(트랜스크립트/스크럽 표시)
          // TTS-ready: 씬 음성 오디오 URL. 현재 미사용(무음). 채우면 타임라인이 오디오 길이에 동기화.
          voice: z.string().optional(),
          // 타이포 카드: 핵심 수치·문구를 이미지 위에 슬라이드로 얹는다.
          card: z
            .object({
              kind: z.enum(['stat', 'title', 'points']).default('stat'),
              big: z.string().optional(),
              label: z.string().optional(),
              sub: z.string().optional(),
              head: z.string().optional(),
              items: z.array(z.string()).optional(),
              // 위치(tl/tr/bl/br/cl/cr/c)·크기(sm/md/lg) — 씬마다 다르게 배치해 단조로움 방지
              pos: z.enum(['tl', 'tr', 'bl', 'br', 'cl', 'cr', 'c']).optional(),
              size: z.enum(['sm', 'md', 'lg']).optional(),
            })
            .optional(),
          // 손가락 포인터: 이미지 속 중요 지점을 👆로 가리키며(이동) 강조
          point: z
            .object({
              x: z.number(), // 목표 X (% 0~100)
              y: z.number(), // 목표 Y (%)
              emoji: z.string().optional(), // 기본 👆
              from: z.tuple([z.number(), z.number()]).optional(), // 시작 위치 [x,y]에서 이동
              label: z.string().optional(), // 포인터 옆 라벨
            })
            .optional(),
        })
      )
      .min(1),
    draft: z.boolean().default(false),
  }),
});

export const collections = { videos };
