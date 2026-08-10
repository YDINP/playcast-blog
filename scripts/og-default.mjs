#!/usr/bin/env node
/**
 * og-default.mjs — 공유 카드(og:image) 기본 이미지를 만든다. → public/og-default.png
 *
 * 예전 이미지는 **폐기된 1세대 로지**(라벤더 단발 + 고양이귀 헤드셋 + 후드)였다. 지금 로지는
 * 민트 롱헤어에 흰 셔츠·틸 타이를 맨 뉴스룸 앵커라, 링크를 공유하면 채널에 없는 캐릭터가 나왔다.
 *
 * AI 로 다시 뽑지 않고 **실제 운영 에셋을 그대로 합성**한다(host/char2/base.webp + newsroom-bg).
 * 그래야 사이트에서 움직이는 로지와 공유 카드의 로지가 같은 그림이 된다 — 생성물로 만들면
 * 얼굴이 미묘하게 달라지고, 리그를 손볼 때마다 카드가 뒤처진다.
 */
import sharp from 'sharp';

const W = 1200;
const H = 630;
const HOST = 'public/host/';
const TEAL = '#57e6c3';

// 스튜디오 배경 — 흐리고 어둡게 눌러 글자와 인물이 앞으로 나오게 한다.
const bg = await sharp(`${HOST}newsroom-bg.webp`)
  .resize(W, H, { fit: 'cover', position: 'centre' })
  .blur(6)
  .modulate({ brightness: 0.52, saturation: 0.85 })
  .toBuffer();

// 로지 — 원본이 500x500 반신이라 카드 높이에 맞춰 키우고 오른쪽에 세운다.
const ROSIE = 610;
const rosie = await sharp(`${HOST}char2/base.webp`).resize(ROSIE, ROSIE).toBuffer();

// 베일은 **로지보다 먼저** 깐다. 한 장의 SVG 에 넣으면 인물 위에 얹혀 로지가 어두워진다
// (배경을 눌러 글자를 띄우려던 것이지, 주인공을 어둡게 하려던 것이 아니다).
const veil = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="veil" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#050a12" stop-opacity="0.92"/>
      <stop offset="55%" stop-color="#050a12" stop-opacity="0.62"/>
      <stop offset="100%" stop-color="#050a12" stop-opacity="0.15"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#veil)"/>
</svg>`;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="10" height="${H}" fill="${TEAL}"/>

  <circle cx="92" cy="176" r="7" fill="#ff4d5e"/>
  <text x="112" y="183" font-family="Segoe UI, sans-serif" font-size="21" font-weight="700"
        letter-spacing="3.4" fill="#ff8d97">ON AIR</text>

  <text x="84" y="330" font-family="Georgia, serif" font-size="128" font-weight="800"
        letter-spacing="6" fill="#ffffff">VIP</text>
  <text x="88" y="374" font-family="Segoe UI, sans-serif" font-size="23" font-weight="600"
        letter-spacing="7.5" fill="${TEAL}">VIRTUAL IN PLAYING</text>

  <rect x="84" y="418" width="58" height="4" fill="${TEAL}"/>
  <text x="84" y="480" font-family="Malgun Gothic, sans-serif" font-size="34" font-weight="700" fill="#ffffff">
    버추얼 호스트 로지가
  </text>
  <text x="84" y="528" font-family="Malgun Gothic, sans-serif" font-size="34" font-weight="700" fill="#ffffff">
    게임을 <tspan fill="${TEAL}">영상처럼</tspan> 소개합니다
  </text>
</svg>`;

await sharp(bg)
  .composite([
    { input: Buffer.from(veil), left: 0, top: 0 },
    { input: rosie, left: W - ROSIE, top: H - ROSIE },
    { input: Buffer.from(svg), left: 0, top: 0 },
  ])
  .png()
  .toFile('public/og-default.png');

console.log(`OK ${W}x${H} -> public/og-default.png`);
