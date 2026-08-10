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
 *     --title "명조: 워더링 웨이브" --sub "WUTHERING WAVES" [--align left|right] [--y 0.52]
 *
 * --align 은 로지가 없는 쪽을 고른다(로지 우측 배치 → --align left).
 * --sub(영문명)은 기본으로 쓰지 않는다 — 표지 벽 타일(305px)로 줄면 글자가 아니라 얼룩으로
 * 남는데, 그 안 읽히는 줄 때문에 검은 바가 두꺼워져 그림을 더 가린다.
 * --y 는 텍스트 블록의 세로 위치(0~1). 로지의 팔·무기가 텍스트 높이까지 뻗어 오는 편은
 * 0.3(위) 이나 0.72(아래) 로 밀어 겹침을 피한다.
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

const { in: input, out, title, sub = '', align = 'left', y: yArg } = args;
if (!input || !out || !title) {
  console.error('usage: --in <img> --out <img> --title "제목" [--sub "SUB"] [--align left|right]');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 한글은 글자당 폭이 거의 1em 이라 글자 수로 폭을 근사할 수 있다.
const emWidth = (text) =>
  [...text].reduce((w, ch) => w + (/[ㄱ-힝]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.62 : 0.48), 0);

// 프레임 폭의 42% 를 넘지 않도록 줄인다. 로지는 폭의 35~60% 를 차지하므로(vip-thumbnail
// 규격) 반대편 42% 안에 머물면 겹치지 않는다.
function fitSize(text, maxW, base) {
  return Math.min(base, Math.floor(maxW / emWidth(text)));
}

const src = sharp(readFileSync(input));
const { width: W, height: H } = await src.metadata();

const isLeft = align === 'left';
const pad = Math.round(W * 0.05);
const x = isLeft ? pad : W - pad;
const anchor = isLeft ? 'start' : 'end';

const titleSize = fitSize(title, W * 0.42, Math.round(H * 0.082));
const subSize = Math.round(titleSize * 0.36);

// 텍스트 블록의 세로 위치. 기본은 중앙보다 약간 위. 하단 15% 는 플레이어 UI 가 덮는다.
const baseY = Math.round(H * Math.min(0.8, Math.max(0.2, Number(yArg) || 0.52)));
const barY = baseY - titleSize - Math.round(H * 0.022);
const subY = baseY + Math.round(titleSize * 0.72);

// ── 텍스트 뒤에만 어둠을 깐다 ──
// 전면 그라디언트는 프레임의 절반을 눌러 그림(배경 플레이 씬)까지 죽였다. 글자가 실제로
// 놓인 사각형에만 검정을 깐다. 흐린 가장자리는 농도를 퍼뜨려 대비를 잃으므로, 경계가
// 딱 떨어지는 사각형으로 두고 정렬한 쪽은 프레임 끝까지 붙여 잘린 여백이 남지 않게 한다.
const blockW = Math.max(emWidth(title) * titleSize, sub ? emWidth(sub) * subSize * 1.25 : 0);
// 여백은 1280px 기준으로 잡히지만 표지 벽(/thumbs)에서는 타일이 305px 까지 줄어든다.
// 넉넉한 여백이 축소되면 검은 바가 타일의 1/3 을 먹으므로 최소한만 준다.
const padX = Math.round(titleSize * 0.5);
const padY = Math.round(titleSize * 0.32);
const boxTop = barY - padY;
const boxH = (sub ? subY + subSize * 0.35 : baseY + titleSize * 0.2) - boxTop + padY;
// 정렬한 쪽은 프레임 끝(0 또는 W)까지 채운다.
const boxLeft = isLeft ? 0 : x - blockW - padX;
const boxW = isLeft ? x + blockW + padX : W - boxLeft;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${Math.round(boxLeft)}" y="${Math.round(boxTop)}" width="${Math.round(boxW)}" height="${Math.round(boxH)}"
        fill="#000" fill-opacity="0.86"/>
  <rect x="${isLeft ? x : x - Math.round(W * 0.045)}" y="${barY}" width="${Math.round(W * 0.045)}" height="5" fill="#57e6c3"/>
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

console.log(`OK ${W}x${H} title="${title}" size=${titleSize} align=${align} -> ${out}`);
