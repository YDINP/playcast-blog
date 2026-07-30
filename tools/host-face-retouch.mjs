#!/usr/bin/env node
/* 승인된 캐릭터 이미지의 얼굴 디테일만 국소 리터치한다.
 *
 *   node tools/host-face-retouch.mjs --diag <src> <dst>          검출 범위 확인용 오버레이
 *   node tools/host-face-retouch.mjs --in <src> --out <dst> [--no-lash] [--no-blush]
 *
 * 왜 재생성이 아니라 리터치인가:
 *   "속눈썹만 지워라" 같은 요청을 생성 모델에 다시 걸면 매번 전체를 다시 그려서
 *   프레임 비율·손 방향·체형까지 바뀐다(실측: 프레임이 2:3→1:2, 마이크 든 손이 반대로).
 *   codex의 image_gen은 입력 이미지를 받는 편집 모드가 없다(EDIT MODE UNAVAILABLE).
 *   그래서 승인본 픽셀을 유지하고 해당 영역만 고친다.
 *
 * 검출 방식:
 *   홍채(앰버)를 색으로 찾아 좌우 눈 bbox를 잡고, 그 아래로 밴드를 만든다.
 *   - 아래 속눈썹 밴드: 홍채 아래 얇은 띠 → 어두운 픽셀을 아래쪽 피부색으로 덮는다
 *   - 볼터치 밴드: 홍채 아래 넓은 띠 → 피부 픽셀의 색조를 이마에서 샘플한 기본 피부색조로 정규화
 *     (입술은 붉기 초과분이 커서 임계값으로 제외한다)
 */
import sharp from 'sharp';

// 홍채(앰버) 실측값: rgb(221,146,66)·(243,173,89) 계열 → r-b가 140~155.
// 그늘진 피부는 r-b가 50~80이라 r-b>115로 확실히 갈린다(느슨하게 잡으면 볼 그늘을 홍채로 오인).
const IRIS = (r, g, b) => r > 180 && r - b > 115 && g < r - 45 && b < 135;
const SKIN = (r, g, b) => r > 200 && g > 155 && b > 130 && r >= g && g >= b;
const LUM = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

async function load(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

/** 홍채 색으로 좌우 눈 bbox 검출 */
function findEyes({ data, W, H }) {
  const pts = [];
  const scanTo = Math.round(H * 0.45);
  for (let y = 0; y < scanTo; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 16) continue;
      if (IRIS(data[i], data[i + 1], data[i + 2])) pts.push([x, y]);
    }
  }
  if (pts.length < 30) throw new Error(`홍채 검출 실패 (${pts.length}px)`);
  // 좌우 눈 분리: x 중앙값으로 자르면 두 홍채가 한쪽에 몰려 들어간다(실측: A가 104px폭).
  // 고유 x값을 정렬해 가장 큰 빈 구간(= 두 눈 사이)에서 자른다.
  const uxs = [...new Set(pts.map(p => p[0]))].sort((a, b) => a - b);
  let split = uxs[Math.floor(uxs.length / 2)], gap = -1;
  for (let i = 1; i < uxs.length; i++) {
    const d = uxs[i] - uxs[i - 1];
    if (d > gap) { gap = d; split = uxs[i]; }
  }
  const box = (sel) => {
    const s = pts.filter(sel);
    return {
      l: Math.min(...s.map(p => p[0])), r: Math.max(...s.map(p => p[0])),
      t: Math.min(...s.map(p => p[1])), b: Math.max(...s.map(p => p[1])),
      n: s.length,
    };
  };
  // 좌우를 x 중앙값으로 가르되, 콧대 근처 오검출을 줄이려 각 군집의 폭으로 검증
  const A = box(p => p[0] < split), B = box(p => p[0] >= split);
  return [A, B].map(e => ({ ...e, w: e.r - e.l + 1, h: e.b - e.t + 1 }));
}

/** 이마에서 기본 피부색조 샘플 */
function baseSkin({ data, W }, eyes) {
  const top = Math.min(...eyes.map(e => e.t)), h = Math.max(...eyes.map(e => e.h));
  const cx = Math.round(eyes.reduce((a, e) => a + (e.l + e.r) / 2, 0) / eyes.length);
  const y0 = Math.max(0, top - Math.round(h * 2.2)), y1 = Math.max(1, top - Math.round(h * 0.8));
  const half = Math.round(h * 1.6);
  const rs = [], gs = [], bs = [];
  for (let y = y0; y < y1; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 16) continue;
      if (!SKIN(data[i], data[i + 1], data[i + 2])) continue;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (rs.length < 30) throw new Error('이마 피부 샘플 실패');
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { r: med(rs), g: med(gs), b: med(bs) };
}

/** 밴드 좌표 계산 — 볼터치 범위는 고정 배수가 아니라 실제 붉기 분포로 정한다.
 *
 * 눈 bbox는 홍채의 밝은 부분만 잡히므로 눈 높이 배수로 볼 범위를 추정하면 너무 짧다
 * (실측: 배수식은 y248~273으로 잡았지만 실제 볼터치는 y244~296).
 * 그래서 행별 "붉기 초과" 픽셀 수 프로파일을 만들어 피크의 25% 아래로 떨어지는 지점까지 넓힌다.
 * 아래로 더 내려가면 입술(y324~)과 목 그늘(y340~)이 나오는데, 그 사이 붉기가 거의 0으로
 * 끊기므로 이 방식이면 자연히 입술 앞에서 멈춘다.
 */
function bands({ data, W, H }, eyes, base) {
  // 아래 속눈썹은 "눈꼬리 쪽 짧은 사선 몇 개"다. 눈 전체 폭을 밴드로 잡으면 아래 눈꺼풀 선과
  // 홍채 아랫부분까지 덮어 눈이 뭉개진다(1차 시도에서 실제로 그랬다).
  // 그래서 좌우 각 눈의 바깥쪽 절반만, 눈꺼풀 선보다 한 칸 아래부터 대상으로 삼는다.
  const cx = eyes.reduce((a, e) => a + (e.l + e.r) / 2, 0) / eyes.length;
  const lash = eyes.map(e => {
    const outer = (e.l + e.r) / 2 < cx; // 화면 왼쪽 눈이면 바깥은 왼쪽
    return {
      y0: e.b + 2,
      y1: e.b + Math.max(7, Math.round(e.h * 1.3)),
      x0: outer ? e.l - Math.round(e.w * 0.6) : Math.round((e.l + e.r) / 2),
      x1: outer ? Math.round((e.l + e.r) / 2) : e.r + Math.round(e.w * 0.6),
    };
  });

  const eyeSpan = Math.max(...eyes.map(e => e.r)) - Math.min(...eyes.map(e => e.l)) + 1;
  const x0 = Math.max(0, Math.min(...eyes.map(e => e.l)) - Math.round(eyeSpan * 0.55));
  const x1 = Math.min(W - 1, Math.max(...eyes.map(e => e.r)) + Math.round(eyeSpan * 0.55));
  const bBot = Math.max(...eyes.map(e => e.b));
  const dRG = base.r - base.g;

  const count = (y) => {
    let n = 0;
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] < 16) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (!SKIN(r, g, b)) continue;
      if ((r - g) - dRG > 4) n++;
    }
    return n;
  };

  const scanBot = Math.min(H - 1, bBot + Math.round(eyeSpan * 1.4));
  let peak = 0;
  for (let y = bBot; y <= scanBot; y++) peak = Math.max(peak, count(y));
  const cut = Math.max(3, Math.round(peak * 0.25));

  let yBot = bBot;
  for (let y = bBot, low = 0; y <= scanBot; y++) {
    if (count(y) < cut) { if (++low >= 5) break; } else { low = 0; yBot = y; }
  }
  let yTop = bBot;
  for (let y = bBot, low = 0; y >= 0; y--) {
    if (count(y) < cut) { if (++low >= 5) break; } else { low = 0; yTop = y; }
  }

  const blush = { x0, x1, y0: yTop, y1: yBot, feather: Math.max(4, Math.round((yBot - yTop) * 0.18)) };
  return { lash, blush };
}

async function diag(src, dst) {
  const img = await load(src);
  const eyes = findEyes(img);
  const base = baseSkin(img, eyes);
  const { lash, blush } = bands(img, eyes, base);
  console.log(`눈: ${eyes.map(e => `x${e.l}..${e.r} y${e.t}..${e.b} (${e.w}x${e.h}, ${e.n}px)`).join(' / ')}`);
  console.log(`기본 피부색조: rgb(${base.r},${base.g},${base.b})  R-G=${base.r - base.g} G-B=${base.g - base.b}`);
  console.log(`속눈썹 밴드: ${lash.map(l => `x${l.x0}..${l.x1} y${l.y0}..${l.y1}`).join(' / ')}`);
  console.log(`볼터치 밴드: x${blush.x0}..${blush.x1} y${blush.y0}..${blush.y1} (feather ${blush.feather})`);

  const svg = `<svg width="${img.W}" height="${img.H}">
    ${eyes.map(e => `<rect x="${e.l}" y="${e.t}" width="${e.w}" height="${e.h}" fill="none" stroke="lime" stroke-width="2"/>`).join('')}
    ${lash.map(l => `<rect x="${l.x0}" y="${l.y0}" width="${l.x1 - l.x0}" height="${l.y1 - l.y0}" fill="red" opacity="0.45"/>`).join('')}
    <rect x="${blush.x0}" y="${blush.y0}" width="${blush.x1 - blush.x0}" height="${blush.y1 - blush.y0}" fill="deepskyblue" opacity="0.25"/>
  </svg>`;
  await sharp(src).composite([{ input: Buffer.from(svg) }]).png().toFile(dst);
  console.log(`→ ${dst} (초록=홍채bbox, 빨강=속눈썹 밴드, 하늘=볼터치 밴드)`);
}

async function retouch(src, dst, doLash, doBlush) {
  const img = await load(src);
  const { data, W, H } = img;
  const eyes = findEyes(img);
  const base = baseSkin(img, eyes);
  const { lash, blush } = bands(img, eyes, base);
  const dRG = base.r - base.g, dGB = base.g - base.b;

  let lashFixed = 0, blushFixed = 0;

  // 1) 아래 속눈썹 제거 — 대상 픽셀 주변(반경 R)의 피부색 평균으로 덮는다.
  //    같은 열의 단일 피부색을 그대로 복사하면 세로 얼룩이 생긴다(1차 시도 실패 원인).
  //    주변 평균이면 음영 변화를 따라가서 자연스럽게 묻힌다.
  if (doLash) {
    const R = 4;
    const src = Uint8Array.from(data); // 덮은 값이 다음 계산에 섞이지 않게 원본 스냅샷을 참조
    for (const L of lash) {
      for (let y = Math.max(0, L.y0); y <= Math.min(H - 1, L.y1); y++) {
        for (let x = Math.max(0, L.x0); x <= Math.min(W - 1, L.x1); x++) {
          const i = (y * W + x) * 4;
          if (data[i + 3] < 16) continue;
          if (LUM(src[i], src[i + 1], src[i + 2]) >= 208) continue; // 이미 밝은 피부면 건드리지 않음
          let n = 0, sr = 0, sg = 0, sb = 0;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const yy = y + dy, xx = x + dx;
              if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
              const j = (yy * W + xx) * 4;
              if (!SKIN(src[j], src[j + 1], src[j + 2])) continue;
              if (LUM(src[j], src[j + 1], src[j + 2]) < 200) continue;
              n++; sr += src[j]; sg += src[j + 1]; sb += src[j + 2];
            }
          }
          if (n < 6) continue; // 주변에 피부가 거의 없으면(눈 안쪽 등) 손대지 않는다
          data[i] = Math.round(sr / n); data[i + 1] = Math.round(sg / n); data[i + 2] = Math.round(sb / n);
          lashFixed++;
        }
      }
    }
  }

  // 2) 볼터치 제거 — 피부 픽셀의 색조를 기본 피부색조로 정규화(밴드 경계는 페더)
  if (doBlush) {
    const { x0, x1, y0, y1, feather } = blush;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      const dTop = y - y0, dBot = y1 - y;
      const w = Math.min(1, Math.min(dTop, dBot) / feather); // 0..1
      if (w <= 0) continue;
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] < 16) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (!SKIN(r, g, b)) continue;
        const excess = (r - g) - dRG;
        if (excess <= 1) continue;      // 붉기 초과 없음
        if (excess > 28) continue;      // 입술 등 진한 부분은 보호
        const tR = g + dRG, tB = g - dGB;
        data[i] = Math.round(r + (tR - r) * w);
        data[i + 2] = Math.round(b + (tB - b) * w);
        blushFixed++;
      }
    }
  }

  await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(dst);
  console.log(`→ ${dst}  속눈썹 ${lashFixed}px, 볼터치 ${blushFixed}px 보정`);
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };

if (argv.includes('--diag')) {
  const [src, dst] = argv.slice(argv.indexOf('--diag') + 1);
  await diag(src, dst);
} else {
  const src = flag('--in'), dst = flag('--out');
  if (!src || !dst) {
    console.error('usage: --diag <src> <dst> | --in <src> --out <dst> [--no-lash] [--no-blush]');
    process.exit(1);
  }
  await retouch(src, dst, !argv.includes('--no-lash'), !argv.includes('--no-blush'));
}
