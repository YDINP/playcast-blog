import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const videos = await getCollection('videos', ({ data }) => !data.draft);
  return rss({
    title: 'playcast — 게임 소개 방송 채널',
    description: '버츄얼 호스트 로지가 게임을 영상처럼 소개하는 채널',
    site: context.site,
    items: videos
      .sort((a, b) => +b.data.pubDate - +a.data.pubDate)
      .map((v) => ({
        title: v.data.title,
        description: v.data.description,
        pubDate: v.data.pubDate,
        categories: v.data.tags,
        link: `/watch/${v.id}/`,
      })),
    customData: `<language>ko-KR</language>`,
  });
}
