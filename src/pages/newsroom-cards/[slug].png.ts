// 뉴스레터용 '뉴스룸' 카드 합성 — watch 페이지 HostStage(booth) 구도를 단일 이미지로 굽는다.
// 이메일 클라(Gmail 등)는 position:absolute 를 제거해 레이어드 오버레이가 세로로 무너지므로,
// 빌드 시점에 배경+게임모니터+로지 앵커+데스크바를 하나로 합성해 /newsroom-cards/<slug>.png 로 출력.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const prerender = true;

const W = 1280;
const H = 720;
const PUB = path.resolve('public');

// 블로그 CSS 비율(.is-newsroom) 그대로: 모니터 left3.5/top5/55x55%, 앵커 right/bottom12/45%, 데스크 12%
const MON = { x: Math.round(W * 0.035), y: Math.round(H * 0.05), w: Math.round(W * 0.55), h: Math.round(H * 0.55) };
const DESK_H = Math.round(H * 0.12);
const DESK_Y = H - DESK_H;
const ANCH_W = Math.round(W * 0.45);
const ANCH_X = W - ANCH_W - Math.round(W * 0.01);
const ANCH_Y = DESK_Y - ANCH_W; // 하단이 데스크 윗변에 맞닿음(정사각 앵커)

export async function getStaticPaths() {
  const vids = await getCollection('videos');
  return vids.map((v) => ({
    params: { slug: v.id },
    props: { scene: v.data.scenes?.[0]?.image || v.data.thumbnail || '' },
  }));
}

async function loadBuf(src: string): Promise<Buffer | null> {
  if (!src) return null;
  try {
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    }
    return await readFile(path.join(PUB, src.replace(/^\//, '')));
  } catch {
    return null;
  }
}

function overlaySvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1a2c56"/><stop offset="0.55" stop-color="#10203f"/><stop offset="1" stop-color="#0a1428"/>
      </linearGradient>
    </defs>
    <!-- 상하 가독성 비네트 -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#none)"/>
    <!-- 데스크바 -->
    <rect x="0" y="${DESK_Y}" width="${W}" height="${DESK_H}" fill="url(#desk)"/>
    <rect x="0" y="${DESK_Y}" width="${W}" height="3" fill="rgba(130,175,255,0.45)"/>
    <text x="${W - 30}" y="${DESK_Y + DESK_H * 0.66}" text-anchor="end" font-family="Georgia, serif" font-weight="800" font-size="34" letter-spacing="3" fill="#8fb2ff">VIP</text>
    <!-- 모니터 테두리 -->
    <rect x="${MON.x}" y="${MON.y}" width="${MON.w}" height="${MON.h}" rx="12" ry="12" fill="none" stroke="rgba(130,175,255,0.6)" stroke-width="3"/>
    <!-- LIVE 태그 -->
    <g>
      <rect x="${MON.x + 14}" y="${MON.y + 14}" width="86" height="30" rx="6" fill="rgba(214,42,64,0.95)"/>
      <circle cx="${MON.x + 30}" cy="${MON.y + 29}" r="5" fill="#fff"/>
      <text x="${MON.x + 44}" y="${MON.y + 34}" font-family="Arial, sans-serif" font-weight="700" font-size="15" letter-spacing="1" fill="#fff">LIVE</text>
    </g>
    <!-- 중앙 재생버튼 -->
    <circle cx="${W / 2}" cy="${H / 2}" r="40" fill="rgba(255,61,84,0.94)"/>
    <path d="M${W / 2 - 12} ${H / 2 - 18} L${W / 2 + 22} ${H / 2} L${W / 2 - 12} ${H / 2 + 18} Z" fill="#fff"/>
  </svg>`;
}

async function roundedMonitor(sceneSrc: string): Promise<Buffer> {
  const buf = await loadBuf(sceneSrc);
  const mask = Buffer.from(`<svg width="${MON.w}" height="${MON.h}"><rect width="${MON.w}" height="${MON.h}" rx="12" ry="12"/></svg>`);
  if (!buf) {
    // 씬 이미지 없음 → 어두운 플레이스홀더
    return sharp({ create: { width: MON.w, height: MON.h, channels: 4, background: { r: 12, b: 32, g: 18, alpha: 1 } } })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }
  return sharp(buf)
    .resize(MON.w, MON.h, { fit: 'cover' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

export const GET: APIRoute = async ({ props }) => {
  const scene = (props as { scene: string }).scene;
  const bgBuf = await loadBuf('/host/newsroom-bg.webp');
  const base = bgBuf
    ? sharp(bgBuf).resize(W, H, { fit: 'cover' })
    : sharp({ create: { width: W, height: H, channels: 4, background: { r: 8, g: 13, b: 26, alpha: 1 } } });

  const monitor = await roundedMonitor(scene);
  const anchorRaw = await loadBuf('/host/char2/base.webp');
  const layers: sharp.OverlayOptions[] = [{ input: monitor, left: MON.x, top: MON.y }];
  if (anchorRaw) {
    const anchor = await sharp(anchorRaw).resize(ANCH_W, ANCH_W, { fit: 'inside' }).png().toBuffer();
    layers.push({ input: anchor, left: ANCH_X, top: Math.max(0, ANCH_Y) });
  }
  layers.push({ input: Buffer.from(overlaySvg()), left: 0, top: 0 });

  const png = await base.composite(layers).png().toBuffer();
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
};
