// 영상 카드/워치 공용 포맷 헬퍼
const PER_CHAR = 58;
const HOLD_DEFAULT = 1100;
const TYPE_MIN = 650;

export interface Scene {
  image?: string;
  text: string;
  emotion?: string;
  holdMs?: number;
  chapter?: string;
  voice?: string;
}

/** 씬 배열 → 예상 총 재생시간(초). scene-player.js와 동일 공식. */
export function estimateSeconds(scenes: Scene[]): number {
  let ms = 0;
  for (const s of scenes) {
    const typing = Math.max(TYPE_MIN, (s.text || '').length * PER_CHAR);
    const hold = typeof s.holdMs === 'number' ? s.holdMs : HOLD_DEFAULT;
    ms += typing + hold;
  }
  return Math.round(ms / 1000);
}

export function durationLabel(scenes: Scene[], override?: string): string {
  if (override) return override;
  const s = estimateSeconds(scenes);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatViews(n: number): string {
  if (n >= 10000) return `조회수 ${(n / 10000).toFixed(1).replace(/\.0$/, '')}만회`;
  if (n >= 1000) return `조회수 ${(n / 1000).toFixed(1).replace(/\.0$/, '')}천회`;
  return `조회수 ${n}회`;
}

export function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const d = Math.floor(diff / 86400000);
  if (d < 1) return '오늘';
  if (d < 7) return `${d}일 전`;
  if (d < 30) return `${Math.floor(d / 7)}주 전`;
  if (d < 365) return `${Math.floor(d / 30)}개월 전`;
  return `${Math.floor(d / 365)}년 전`;
}

export function watchHref(id: string): string {
  return `/watch/${id}/`;
}

export function posterOf(data: { thumbnail?: string; scenes: Scene[] }): string | undefined {
  return data.thumbnail || data.scenes.find((s) => s.image)?.image;
}
