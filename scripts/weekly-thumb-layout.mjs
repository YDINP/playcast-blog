// weekly-thumb-layout.mjs — 주간결산 썸네일 새 레이아웃.
//
// 기존 방식(thumb-text.mjs)은 좌측에 "주간결산 / N월N주차"를 세로로 쌓는다.
// 이 스크립트는 다른 배치를 만든다:
//   · 상단  "주간결산"    — 화면을 꽉 채우는 크기, **캐릭터 뒤**로 깔린다
//   · 중앙  캐릭터
//   · 하단  "N월N주차"   — 크게, 캐릭터 앞
//
// 캐릭터 뒤에 글자를 넣으려면 인물 알파가 필요하다. 배경블러에 쓰던
// tools/thumb-subject-mask.py(rembg birefnet-general)를 그대로 재사용한다
// — 그 파일 주석대로 **소품까지 전경으로 무는** 모델이라 손에 든 물건이 잘려 나가지 않는다.
//
// 합성 순서:  원본 → 상단 글자 → (마스크로 오려낸) 인물 → 하단 글자
//   상단 글자가 인물에 가려지고, 하단 글자는 인물 위에 올라온다.
//
// 사용:
//   node scripts/weekly-thumb-layout.mjs --in <base.png|jpg> --out <out.jpg> --week "9월 1주차"
//   [--title 주간결산] [--mask <미리 뽑은 마스크>] [--no-mask]
//
// ⚠ --no-mask 면 상단 글자도 인물 **앞**에 그려진다(마스크 실패 시 폴백).

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const IN = arg('--in');
const OUT = arg('--out');
const WEEK = arg('--week');
const TITLE = arg('--title', '주간결산');
if (!IN || !OUT || !WEEK) {
  console.error('usage: --in <img> --out <jpg> --week "9월 1주차" [--title 주간결산] [--mask m.png] [--no-mask]');
  process.exit(1);
}

const W = 1280;
const H = 720;
const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const FONT = join(ROOT, 'assets', 'fonts', 'Jua-Regular.ttf');
if (!existsSync(FONT)) { console.error(`⛔ 폰트 없음: ${FONT}`); process.exit(1); }

/* SVG 안에 폰트를 파일 경로로 걸면 sharp(librsvg)가 시스템 폰트만 찾는다.
   그래서 @font-face 로 **파일 URL** 을 직접 물린다. 경로에 공백이 있어도
   file:/// 형식이면 librsvg 가 읽는다. */
const fontUrl = 'file:///' + FONT.replace(/\\/g, '/');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 한 줄 텍스트를 PNG 버퍼로. 외곽선을 넉넉히 줘 어떤 배경에서도 읽히게 한다.
 *  span 을 주면 **그 폭에 정확히 맞춰 늘린다**(textLength + lengthAdjust).
 *  ⚠ lengthAdjust="spacing" 만 쓰면 자간만 벌어져 글자가 흩어진다.
 *    "양옆으로 꽉 찬" 인상을 내려면 글리프까지 늘리는 spacingAndGlyphs 가 맞다. */
async function textPng(txt, { size, fill, stroke, strokeW, y, span = null }) {
  const fit = span ? ` textLength="${span}" lengthAdjust="spacingAndGlyphs"` : '';
  /* ⚠ Jua 는 굵기가 하나뿐이라 font-weight 를 올려도 안 굵어진다(librsvg 는 가짜 볼드를
     만들지 않는다). 그래서 **채움색과 같은 색 외곽선을 한 겹 더** 둘러 획 자체를 불린다.
     순서가 중요하다: 바깥 어두운 테두리 → 같은 색 두께 → 채움. */
  const bold = Math.round(size * 0.035);  // 획을 불리는 두께(과하면 획끼리 붙어 뭉갠다)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<style>
  @font-face { font-family: 'JuaLocal'; src: url('${fontUrl}') format('truetype'); }
  .base { font-family: 'JuaLocal'; font-size: ${size}px; text-anchor: middle;
          paint-order: stroke fill; stroke-linejoin: round; }
  .edge { stroke: ${stroke}; stroke-width: ${strokeW + bold}px; fill: ${fill}; }
  .fat  { stroke: ${fill};   stroke-width: ${bold}px;          fill: ${fill}; }
</style>
<text class="base edge" x="${W / 2}" y="${y}"${fit}>${esc(txt)}</text>
<text class="base fat"  x="${W / 2}" y="${y}"${fit}>${esc(txt)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── 0) 베이스를 규격으로
const base = await sharp(IN).resize(W, H, { fit: 'cover', position: 'attention' }).toBuffer();

// ── 1) 인물 마스크
let subject = null;
if (!has('--no-mask')) {
  let maskPath = arg('--mask');
  let tmpMask = null;
  if (!maskPath) {
    mkdirSync(join(ROOT, '.tmp'), { recursive: true });
    tmpMask = join(ROOT, '.tmp', 'weekly-layout-mask.png');
    const tmpIn = join(ROOT, '.tmp', 'weekly-layout-base.png');
    await sharp(base).png().toFile(tmpIn);
    /* ⚠ rembg·PIL 이 들어 있는 건 **venv-img** 다.
       venv-midi(Basic Pitch 전용)와 roji-tts 에는 없다 — 실측으로 확인했다. */
    const py = join(ROOT, 'tools', 'venv-img', 'Scripts', 'python.exe');
    const python = existsSync(py) ? py : 'python';
    const r = spawnSync(python, [join(ROOT, 'tools', 'thumb-subject-mask.py'), tmpIn, tmpMask], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(tmpMask)) {
      console.error(`⚠ 마스크 실패 — 상단 글자를 인물 앞에 그린다\n${(r.stderr || '').slice(0, 300)}`);
    } else { maskPath = tmpMask; }
  }
  if (maskPath && existsSync(maskPath)) {
    /* ⚠ 마스크를 화면 전체에 그대로 쓰면 **하단에서 인물이 흐려진다.**
       rembg 는 프레임에 걸리는 아래쪽에서 알파를 반투명하게 주는데, 그게
       "캐릭터가 아래로 갈수록 사라지는" 그라데이션처럼 보인다(실측).
       사실 마스크가 필요한 곳은 **상단 글자를 덮는 띠뿐**이다 — 그 아래는
       베이스에 인물이 이미 온전히 그려져 있으니 마스크를 안 쓰면 된다.
       그래서 알파를 TOP_BAND 아래에서 0 으로 잘라 낸다. 잘린 경계가 안 보이는 이유는
       인물 레이어와 베이스가 **같은 그림**이라 그 아래에서 완전히 겹치기 때문이다. */
    const TOP_BAND = 270;   // 상단 글자(baseline 158, size 168)를 넉넉히 덮는 높이
    const band = await sharp({
      create: { width: W, height: H, channels: 3, background: '#000000' },
    }).composite([{
      input: await sharp({ create: { width: W, height: TOP_BAND, channels: 3, background: '#ffffff' } })
        .png().toBuffer(),
      top: 0, left: 0,
    }]).greyscale().png().toBuffer();

    const alpha = await sharp(maskPath).resize(W, H, { fit: 'fill' }).greyscale()
      .composite([{ input: band, blend: 'multiply' }]).toBuffer();
    subject = await sharp(base).ensureAlpha().joinChannel(alpha).png().toBuffer();
    console.log(`   ✅ 인물 마스크 확보(상단 ${TOP_BAND}px 에만 적용 — 하단 흐려짐 방지)`);
  }
  if (tmpMask && existsSync(tmpMask) && !arg('--mask')) { try { unlinkSync(tmpMask); } catch {} }
}

/** 제목을 반으로 갈라 **좌우 끝에 하나씩** 붙인다("주간" ←→ "결산").
 *  가운데가 비어 캐릭터 얼굴이 글자에 안 묻힌다. 한 덩어리로 늘리는 것보다
 *  글리프 왜곡도 없다(늘리기를 안 쓰므로 원래 자획 비율이 유지된다). */
async function splitTitlePng(txt, { size, fill, stroke, strokeW, y, pad = 26 }) {
  const mid = Math.ceil(txt.length / 2);
  const [l, r] = [txt.slice(0, mid), txt.slice(mid)];
  const bold = Math.round(size * 0.035);
  const one = (t, x, anchor) =>
    `<text class="base edge" x="${x}" y="${y}" text-anchor="${anchor}">${esc(t)}</text>`
    + `<text class="base fat" x="${x}" y="${y}" text-anchor="${anchor}">${esc(t)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<style>
  @font-face { font-family: 'JuaLocal'; src: url('${fontUrl}') format('truetype'); }
  .base { font-family: 'JuaLocal'; font-size: ${size}px; paint-order: stroke fill; stroke-linejoin: round; }
  .edge { stroke: ${stroke}; stroke-width: ${strokeW + bold}px; fill: ${fill}; }
  .fat  { stroke: ${fill};   stroke-width: ${bold}px;          fill: ${fill}; }
</style>
${one(l, pad, 'start')}
${one(r, W - pad, 'end')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── 2) 글자
//    상단 "주간" ←→ "결산" — 좌우 끝에 붙여 가운데를 비운다. 인물 뒤로 들어간다.
const top = await splitTitlePng(TITLE, {
  size: 168, fill: '#ffffff', stroke: '#0b1020', strokeW: 14, y: 158,
});
//    하단 "N월N주차" — 인물 앞. 민트로 포인트. 상단보다는 좁게 잡아 위계를 준다.
const bottom = await textPng(WEEK, {
  size: 150, fill: '#6ff2d0', stroke: '#0b1020', strokeW: 16, y: H - 34, span: Math.round(W * 0.72),
});

// ── 3) 합성: 원본 → 상단 글자 → 인물 → 하단 글자
const layers = [{ input: top }];
if (subject) layers.push({ input: subject });
layers.push({ input: bottom });

await sharp(base).composite(layers).jpeg({ quality: 88 }).toFile(OUT);
console.log(`OK ${W}x${H} "${TITLE}" / "${WEEK}" ${subject ? '(글자 뒤 인물 합성)' : '(마스크 없이)'} -> ${OUT}`);
