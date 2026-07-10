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
    durationLabel: z.string().optional(), // 표시용 "3:24" (미지정 시 씬 합산 자동)
    views: z.number().default(0), // 표시용 조회수 시드
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
        })
      )
      .min(1),
    draft: z.boolean().default(false),
  }),
});

export const collections = { videos };
