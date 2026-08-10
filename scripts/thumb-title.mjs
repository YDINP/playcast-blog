#!/usr/bin/env node
/**
 * thumb-title.mjs — VIP(playcast) 썸네일에 게임 제목 텍스트를 얹는다.
 *
 * 썸네일 원본은 codex image_gen 으로 "텍스트 없이" 뽑는다(생성 모델은 한글을 못 쓴다).
 * 제목은 여기서 벡터 텍스트로 합성한다 — 그래야 글자가 뭉개지지 않고, 문구를 바꿀 때
 * 그림을 다시 뽑지 않아도 된다.
 *
 * 사용:
 *   node scripts/thumb-title.mjs \
 *     --in public/games/<slug>-thumb.jpg --out public/games/<slug>-thumb.jpg \
 *     --title "명조: 워더링 웨이브" [--align left|right|auto] [--y 0.52]
 *
 * --align/--y 를 주지 않으면 **자리를 자동으로 고른다**(§ pickPlacement). 좌우 6개 × 세로
 * 13개 후보 상자를 훑어 캐릭터·디테일이 가장 적은 칸에 얹는다. 자리는 편마다 달라도 된다 —
 * 일정한 위치보다 "아무것도 가리지 않는 것"이 우선이다.
 * --sub(영문명)은 기본으로 쓰지 않는다 — 표지 벽 타일(305px)로 줄면 글자가 아니라 얼룩으로
 * 남는데, 그 안 읽히는 줄 때문에 검은 바가 두꺼워져 그림을 더 가린다.
 *
 * ⚠️ --in 과 --out 을 같은 경로로 줘도 안전하다(원본을 먼저 버퍼로 읽는다).
 *    단 두 번 실행하면 글자가 겹쳐 찍히므로, 다시 얹으려면 git 으로 원본을 되돌린 뒤 실행한다.
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);

const { in: input, out, title, sub = '', align = 'auto', y: yArg } = args;
if (!input || !out || !title) {
  console.error('usage: --in <img> --out <img> --title "제목" [--sub "SUB"] [--align left|right|auto] [--y 0.5]');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 한글은 글자당 폭이 거의 1em 이라 글자 수로 폭을 근사할 수 있다.
const emWidth = (text) =>
  [...text].reduce((w, ch) => w + (/[ㄱ-힝]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.62 : 0.48), 0);

/**
 * 화소별 "가리면 안 되는 정도" 지도.
 *  - 디테일(밝기 기울기): 캐릭터·오브젝트는 가장자리가 많다. 하늘·벽·바닥은 평평하다.
 *  - 민트 색면: 로지의 머리·의상 포인트. 이 편들에서 로지는 언제나 주제부다.
 *  - 살색: 얼굴·손. 덮으면 가장 티가 나므로 디테일보다 무겁게 센다.
 * 적분영상으로 만들어 두면 후보 상자마다 O(1) 로 평균을 구할 수 있다.
 */
async function buildCost(buf) {
  const { data, info } = await sharp(buf).resize({ width: 200 }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const lum = new Float32Array(w * h);
  const mask = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += c) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    lum[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (d < 12 || mx < 60) continue;
    let hue;
    if (mx === r) hue = 60 * (((g - b) / d) % 6);
    else if (mx === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
    if (hue < 0) hue += 360;
    const sat = d / mx;
    if (hue >= 135 && hue <= 195 && g >= r && sat > 0.12) mask[p] += 3; // 민트 = 로지
    else if (hue >= 8 && hue <= 42 && sat > 0.14 && sat < 0.62 && mx > 120) mask[p] += 2; // 살색
  }
  const cost = new Float32Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const p = py * w + px;
      const gx = Math.abs(lum[p] - lum[py * w + Math.min(w - 1, px + 1)]);
      const gy = Math.abs(lum[p] - lum[Math.min(h - 1, py + 1) * w + px]);
      cost[p] = Math.min(1, (gx + gy) * 5) + mask[p];
    }
  }
  // 적분영상 (w+1) x (h+1)
  const I = new Float64Array((w + 1) * (h + 1));
  for (let py = 0; py < h; py++) {
    let run = 0;
    for (let px = 0; px < w; px++) {
      run += cost[py * w + px];
      I[(py + 1) * (w + 1) + px + 1] = I[py * (w + 1) + px + 1] + run;
    }
  }
  return { I, w, h };
}

const boxMean = ({ I, w, h }, x0, y0, x1, y1) => {
  const a = Math.max(0, Math.min(w, Math.round(x0)));
  const b = Math.max(0, Math.min(h, Math.round(y0)));
  const cx = Math.max(0, Math.min(w, Math.round(x1)));
  const cy = Math.max(0, Math.min(h, Math.round(y1)));
  const area = Math.max(1, (cx - a) * (cy - b));
  const s =
    I[cy * (w + 1) + cx] - I[b * (w + 1) + cx] - I[cy * (w + 1) + a] + I[b * (w + 1) + a];
  return s / area;
};

const raw = readFileSync(input);
const src = sharp(raw);
const { width: W, height: H } = await src.metadata();

// 프레임 폭의 42% 를 넘지 않도록 줄인다. 로지는 폭의 35~60% 를 차지하므로(vip-thumbnail
// 규격) 반대편 42% 안에 머물면 겹치지 않는다.
const titleSize = Math.min(Math.round(H * 0.082), Math.floor((W * 0.42) / emWidth(title)));
const subSize = Math.round(titleSize * 0.36);
// 프레임 가장자리와 글자 사이. 5% 로는 짧은 제목("산나비")의 상자가 모서리에 낀 작은 탭처럼
// 보였다 — 상자를 프레임 끝까지 붙이는 이상, 안쪽 여백이 곧 상자의 두께다.
const pad = Math.round(W * 0.075);
const blockW = Math.max(emWidth(title) * titleSize, sub ? emWidth(sub) * subSize * 1.25 : 0);
const padX = Math.round(titleSize * 0.75);
const padY = Math.round(titleSize * 0.32);

/**
 * 정렬·세로위치로부터 실제 좌표를 만든다. 후보 평가와 렌더가 같은 식을 쓰게 한 곳에 모았다.
 * left/right 는 상자를 프레임 끝까지 붙인 띠, center 는 좌우 어느 쪽에도 닿지 않는 독립 상자다
 * (가운데가 비고 양쪽이 찬 그림에서 필요하다).
 */
function geom(sideName, yRatio) {
  const isL = sideName === 'left';
  const isC = sideName === 'center';
  const x = isC ? Math.round(W / 2) : isL ? pad : W - pad;
  const baseY = Math.round(H * yRatio);
  const barY = baseY - titleSize - Math.round(H * 0.022);
  const subY = baseY + Math.round(titleSize * 0.72);
  const boxTop = barY - padY;
  const boxH = (sub ? subY + subSize * 0.35 : baseY + titleSize * 0.2) - boxTop + padY;
  const boxLeft = isC ? Math.round((W - blockW) / 2) - padX : isL ? 0 : x - blockW - padX;
  const boxW = isC ? blockW + padX * 2 : isL ? x + blockW + padX : W - boxLeft;
  const barW = Math.round(W * 0.045);
  const barX = isC ? Math.round((W - barW) / 2) : isL ? x : x - barW;
  return {
    isL,
    x,
    baseY,
    barY,
    barX,
    barW,
    subY,
    boxTop,
    boxH,
    boxLeft,
    boxW,
    anchor: isC ? 'middle' : isL ? 'start' : 'end',
  };
}

/**
 * 후보 상자 중 비용이 가장 낮은 자리를 고른다.
 * 세로는 0.20~0.80 (하단 15% 는 플레이어 UI 가 덮으므로 0.8 이 상한).
 */
function pickPlacement(cost, sideFixed, yFixed) {
  const sides = sideFixed && sideFixed !== 'auto' ? [sideFixed] : ['left', 'center', 'right'];
  const ys = yFixed !== undefined ? [Number(yFixed)] : [];
  if (!ys.length) for (let v = 0.2; v <= 0.801; v += 0.05) ys.push(Number(v.toFixed(2)));
  let best = null;
  for (const s of sides) {
    for (const yr of ys) {
      const g = geom(s, yr);
      const sc = boxMean(
        cost,
        (g.boxLeft / W) * cost.w,
        (g.boxTop / H) * cost.h,
        ((g.boxLeft + g.boxW) / W) * cost.w,
        ((g.boxTop + g.boxH) / H) * cost.h
      );
      if (!best || sc < best.score) best = { side: s, y: yr, score: sc };
    }
  }
  return best;
}

const cost = await buildCost(raw);
const picked = pickPlacement(cost, align, yArg);
const { x, baseY, barY, barX, barW, subY, boxTop, boxH, boxLeft, boxW, anchor } = geom(picked.side, picked.y);

// ── 텍스트 뒤에만 어둠을 깐다 ──
// 전면 그라디언트는 프레임의 절반을 눌러 그림(배경 플레이 씬)까지 죽였다. 글자가 실제로
// 놓인 사각형에만 검정을 깐다. 흐린 가장자리는 농도를 퍼뜨려 대비를 잃으므로, 경계가
// 딱 떨어지는 사각형으로 두고 정렬한 쪽은 프레임 끝까지 붙여 잘린 여백이 남지 않게 한다.
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${Math.round(boxLeft)}" y="${Math.round(boxTop)}" width="${Math.round(boxW)}" height="${Math.round(boxH)}"
        fill="#000" fill-opacity="0.86"/>
  <rect x="${barX}" y="${barY}" width="${barW}" height="5" fill="#57e6c3"/>
  <text x="${x}" y="${baseY}" text-anchor="${anchor}"
        font-family="Malgun Gothic, Segoe UI, sans-serif" font-size="${titleSize}" font-weight="700"
        fill="#fff" stroke="#04121a" stroke-width="${Math.max(3, Math.round(titleSize * 0.07))}"
        paint-order="stroke">${esc(title)}</text>
  ${
    sub
      ? `<text x="${x}" y="${subY}" text-anchor="${anchor}"
        font-family="Segoe UI, sans-serif" font-size="${subSize}" font-weight="600" letter-spacing="${(subSize * 0.22).toFixed(1)}"
        fill="#57e6c3" stroke="#04121a" stroke-width="2.5" paint-order="stroke">${esc(sub)}</text>`
      : ''
  }
</svg>`;

await src
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .jpeg({ quality: 88 })
  .toFile(out);

console.log(
  `OK ${W}x${H} title="${title}" size=${titleSize} place=${picked.side}@${picked.y} cost=${picked.score.toFixed(3)} -> ${out}`
);
