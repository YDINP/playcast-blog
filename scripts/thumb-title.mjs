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
 *     --title "명조: 워더링 웨이브" --sub "WUTHERING WAVES" [--align left|right]
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

const { in: input, out, title, sub = '', align = 'left' } = args;
if (!input || !out || !title) {
  console.error('usage: --in <img> --out <img> --title "제목" [--sub "SUB"] [--align left|right]');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 한글은 글자당 폭이 거의 1em 이라 글자 수로 폭을 근사할 수 있다. 프레임 폭의 52% 를
// 넘지 않도록 줄여, 긴 제목이 로지(반대편 주제부)를 침범하지 않게 한다.
function fitSize(text, maxW, base) {
  const em = [...text].reduce((w, ch) => w + (/[ㄱ-힝]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.62 : 0.48), 0);
  return Math.min(base, Math.floor(maxW / em));
}

const src = sharp(readFileSync(input));
const { width: W, height: H } = await src.metadata();

const isLeft = align === 'left';
const pad = Math.round(W * 0.05);
const x = isLeft ? pad : W - pad;
const anchor = isLeft ? 'start' : 'end';

const titleSize = fitSize(title, W * 0.52, Math.round(H * 0.082));
const subSize = Math.round(titleSize * 0.36);

// 텍스트 블록은 세로 중앙보다 약간 위. 하단 15% 는 플레이어 UI 가 덮으므로 비운다.
const baseY = Math.round(H * 0.52);
const barY = baseY - titleSize - Math.round(H * 0.022);

// 스크림: 텍스트 쪽 가장자리만 눌러 대비를 만든다. 배경 전체를 어둡게 하면 그림이 죽는다.
const g1 = isLeft ? '0%' : '100%';
const g2 = isLeft ? '100%' : '0%';

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="${g1}" y1="0%" x2="${g2}" y2="0%">
      <stop offset="0%" stop-color="#000" stop-opacity="0.62"/>
      <stop offset="42%" stop-color="#000" stop-opacity="0.34"/>
      <stop offset="72%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>
  <rect x="${isLeft ? x : x - Math.round(W * 0.045)}" y="${barY}" width="${Math.round(W * 0.045)}" height="5" fill="#57e6c3"/>
  <text x="${x}" y="${baseY}" text-anchor="${anchor}"
        font-family="Malgun Gothic, Segoe UI, sans-serif" font-size="${titleSize}" font-weight="700"
        fill="#fff" stroke="#04121a" stroke-width="${Math.max(3, Math.round(titleSize * 0.07))}"
        paint-order="stroke">${esc(title)}</text>
  ${
    sub
      ? `<text x="${x}" y="${baseY + Math.round(titleSize * 0.72)}" text-anchor="${anchor}"
        font-family="Segoe UI, sans-serif" font-size="${subSize}" font-weight="600" letter-spacing="${(subSize * 0.22).toFixed(1)}"
        fill="#57e6c3" stroke="#04121a" stroke-width="2.5" paint-order="stroke">${esc(sub)}</text>`
      : ''
  }
</svg>`;

await src
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .jpeg({ quality: 88 })
  .toFile(out);

console.log(`OK ${W}x${H} title="${title}" size=${titleSize} align=${align} -> ${out}`);
