#!/usr/bin/env node
/**
 * thumb-focus-blur.mjs — VIP 썸네일 배경만 약하게 흐린다(피사계 심도).
 *
 * 왜 전체 블러가 아닌가: 로지(호스트)는 주제부라 흐려지면 안 되고, 게임 장면도
 * "한눈에 알아볼 수 있어야" 한다(automation/vip-run.mjs:248 — 예전 프롬프트가 배경을
 * blurred smear 로 밀어냈다가 되돌린 이력). 그래서 blur 를 깔고 그 위에 **로지 영역만
 * 원본을 깃털 마스크로 다시 얹는다**. 결과는 렌즈로 찍은 듯한 얕은 심도지, 뭉갠 배경이 아니다.
 *
 * 사용:
 *   node scripts/thumb-focus-blur.mjs --in <img> --out <img>
 *     [--sigma 6] [--cx 0.72] [--cy 0.55] [--rx 0.34] [--ry 0.62] [--feather 0.72]
 *
 * cx/cy/rx/ry 는 **이미지 대비 비율**(0~1). 기본값은 로지가 오른쪽에 서는 표준 구도 기준이다.
 * 로지가 왼쪽에 선 편이면 --cx 0.28 처럼 뒤집어 준다.
 *
 * ⚠️ --in 과 --out 이 같아도 안전하다(원본을 먼저 버퍼로 읽는다). 다만 두 번 돌리면
 *    배경이 두 번 흐려지므로, 다시 하려면 git 으로 원본을 되돌린 뒤 실행한다.
 * ⚠️ 제목 합성(thumb-title.mjs)보다 **먼저** 돌릴 것 — 순서가 바뀌면 글자까지 흐려진다.
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, [])
);

const { in: input, out, mask: maskPath } = args;
if (!input || !out) {
  console.error('usage: --in <img> --out <img> [--mask <silhouette.png>] [--sigma 6] [--cx 0.72] [--cy 0.55] [--rx 0.34] [--ry 0.62] [--feather 0.72]');
  process.exit(1);
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const sigma = num(args.sigma, 6);
const cx = num(args.cx, 0.72);
const cy = num(args.cy, 0.55);
const rx = num(args.rx, 0.34);
const ry = num(args.ry, 0.62);
// feather: 마스크가 완전히 불투명한 지점(0~1). 이 바깥부터 가장자리까지 서서히 사라진다.
const feather = num(args.feather, 0.72);

const srcBuf = readFileSync(input);
const meta = await sharp(srcBuf).metadata();
const W = meta.width ?? 1280;
const H = meta.height ?? 720;

/* 마스크 = "선명하게 남길 영역". 두 가지 방식이 있다.
   ① --mask: 캐릭터 실루엣 알파(tools/thumb-subject-mask.py 가 rembg isnet-anime 로 뽑는다).
      **이쪽이 기본이어야 한다** — 타원은 인물 주변 배경까지 선명하게 남겨 경계가 뜬다.
      가장자리를 1px 흐려 계단을 없앤다(rembg 매트가 이미 반투명 경계를 주지만 리사이즈 때 각진다).
   ② 타원 폴백: 마스크를 못 뽑는 그림(실사·다인물)에서 쓰는 근사. */
let mask;
if (maskPath) {
  const m = sharp(readFileSync(maskPath)).resize(W, H, { fit: 'fill' }).blur(1.2);
  // 그레이스케일 값을 알파로 옮긴다. 흰색(255)=원본 유지, 검정(0)=블러.
  const gray = await m.greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = gray[i];
  }
  mask = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
} else {
  mask = Buffer.from(`<svg width="${W}" height="${H}">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="${Math.round(feather * 100)}%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="${Math.round(cx * W)}" cy="${Math.round(cy * H)}"
           rx="${Math.round(rx * W)}" ry="${Math.round(ry * H)}" fill="url(#g)"/>
</svg>`);
}

// 원본을 마스크로 오려 낸다(dest-in = 알파만 남김).
const focus = await sharp(srcBuf)
  .ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer();

const blurred = await sharp(srcBuf).blur(sigma).toBuffer();

const result = await sharp(blurred)
  .composite([{ input: focus, left: 0, top: 0 }])
  .jpeg({ quality: 92 })
  .toBuffer();

await sharp(result).toFile(out);
console.log(
  maskPath
    ? `✅ 배경 블러 sigma=${sigma} · 초점=캐릭터 실루엣(${maskPath}) → ${out}`
    : `✅ 배경 블러 sigma=${sigma} · 초점 타원 (${cx}, ${cy}) r=(${rx}, ${ry}) feather=${feather} → ${out}`
);
