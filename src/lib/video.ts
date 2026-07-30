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

/** 자막 강조 세그먼트 (**...** 한 조각) */
export interface EmSeg {
  s: string;
  em: boolean;
}

/** 자막 `**키워드**` 구문 → [{s, em}] 세그먼트. 마커는 표시 길이에서 제외. */
export function parseEmphasis(text: string): EmSeg[] {
  const out: EmSeg[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ s: text.slice(last, m.index), em: false });
    out.push({ s: m[1], em: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ s: text.slice(last), em: false });
  return out;
}

/** `**` 마커를 제거한 순수 텍스트(길이 계산·SEO·og용). */
export function stripEmphasis(text: string): string {
  return (text || '').replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** 씬 배열 → 예상 총 재생시간(초). scene-player.js와 동일 공식. */
export function estimateSeconds(scenes: Scene[]): number {
  let ms = 0;
  for (const s of scenes) {
    // 타이핑 시간은 강조 마커를 제외한 실제 표시 글자 수 기준
    const typing = Math.max(TYPE_MIN, stripEmphasis(s.text || '').length * PER_CHAR);
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

/* ── 카드 카테고리 태그의 시효 ──────────────────────────────────────────────
   category 값의 24/34가 literal "New"라서, 그대로 두면 반년 지난 편도 New 로 보인다.
   "New"는 발행 후 FRESH_DAYS(2일)까지만 쓰고, 그 뒤엔 원래 코너 태그로 내려간다.
   category 자체가 "New"인 글은 대체 라벨이 없으므로 기본 코너명(게임소개)을 쓴다.

   정적 사이트라 여기서 나온 값은 '빌드 시점' 판정이다. 실제 '접속 날짜' 기준 보정은
   BaseLayout 의 인라인 스크립트가 .vcard[data-pub] 를 훑어 라벨·글로우·필터키를 갱신한다.
   판정은 시각이 아니라 KST 달력일 기준 — "접속 날짜로 2일까지"를 그대로 옮긴 것.        */
export const FRESH_DAYS = 2;
export const CORNER_DEFAULT = '게임소개';

export function kstDay(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 시효가 지나면 쓰는 코너 태그(New 이외의 category 는 그대로). */
export function baseCategory(category: string): string {
  return category === 'New' ? CORNER_DEFAULT : category;
}

/** 지금(now) 기준으로 카드에 보여줄 카테고리 라벨. */
export function displayCategory(category: string, pubDate: Date, now: Date = new Date()): string {
  const ageDays = (Date.parse(kstDay(now)) - Date.parse(kstDay(pubDate))) / 86_400_000;
  return ageDays <= FRESH_DAYS ? 'New' : baseCategory(category);
}
