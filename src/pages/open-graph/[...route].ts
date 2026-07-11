import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';

export const prerender = true;

const entries = await getCollection('videos', ({ data }) => !data.draft);
const pages = Object.fromEntries(entries.map((e) => [e.id, e.data]));

const catAccent: Record<string, [number, number, number]> = {
  free: [87, 230, 195],
  indie: [139, 123, 255],
  review: [236, 72, 153],
  guide: [255, 179, 71],
};

function durLabel(scenes: any[]): string {
  let ms = 0;
  for (const s of scenes || []) {
    const typing = Math.max(650, (s.text || '').length * 58);
    ms += typing + (typeof s.holdMs === 'number' ? s.holdMs : 1100);
  }
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const _route = await OGImageRoute({
  param: 'route',
  pages,
  getImageOptions: (_id, page: any) => {
    const cat = (page.category || '').toLowerCase();
    const accent = catAccent[cat] || [87, 230, 195];
    const dur = page.durationLabel || durLabel(page.scenes);
    return {
      title: page.title,
      description: `▶ VIP · 로지의 게임 소개 · ${dur}`,
      bgGradient: [
        [15, 15, 17],
        [26, 20, 46],
      ],
      border: { color: accent, width: 16, side: 'inline-start' },
      padding: 70,
      font: {
        title: {
          color: [255, 255, 255],
          size: 64,
          weight: 'Bold',
          lineHeight: 1.22,
          families: ['Pretendard'],
        },
        description: {
          color: [200, 200, 210],
          size: 30,
          lineHeight: 1.4,
          families: ['Pretendard'],
        },
      },
      fonts: [
        './src/assets/og-fonts/Pretendard-Bold.otf',
        './src/assets/og-fonts/Pretendard-Regular.otf',
      ],
    };
  },
});

export const getStaticPaths = _route.getStaticPaths;
export const GET = _route.GET;
