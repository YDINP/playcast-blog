#!/usr/bin/env node
/* 리포터 베이스 이미지를 공용 캔버스 규격에 맞춘다.
 *
 *   node tools/host-base-align.mjs --measure <img> [<img>...]
 *   node tools/host-base-align.mjs --in <src> --out <dst> [--scale-nudge 1.0]
 *
 * 왜 필요한가:
 *   생성 모델은 "정수리를 상단 5%에" 같은 픽셀 규격을 지키지 못한다. 그래서 규격은
 *   생성 프롬프트가 아니라 후처리로 강제한다. 캐릭터별로 인물 크기·위치가 달라도
 *   이 도구를 통과하면 같은 캔버스·같은 눈높이·같은 신장 비율이 된다.
 *
 * 정렬 기준(REPORTER_SPEC) — 얼굴을 기준점으로 삼는다:
 *   - 캔버스 900x1350 (2:3), 흰 배경
 *   - 스케일: 얼굴 광대폭(FACE_W)을 캔버스 가로 비율로 정규화 → 인물 크기 통일
 *   - 수직: 광대선(=눈높이 근처)을 캔버스 높이의 CHEEK_Y 위치에 맞춘다
 *   - 수평: 얼굴 중심을 캔버스 가로 중앙에 맞춘다
 *   - 하단은 잘리는 대로 둔다(허벅지 중간에서 프레임 아웃되는 것이 정상)
 *
 * 왜 얼굴인가:
 *   머리 폭·어깨 폭은 헤어 볼륨(포니테일/단발)에 좌우돼 캐릭터마다 30~43%까지 벌어진다.
 *   실제로 어깨행 검출은 미아 54%/레이 미검출로 실패했다. 반면 광대폭은 헤어와 무관하고,
 *   광대선은 눈높이에 근접해 "같은 눈높이"라는 목표에 바로 대응된다.
 */
import sharp from 'sharp';

// 수치 근거(실측): 승인된 두 시안의 광대선 21.3%/20.1%, 얼굴폭 21.5%/22.5%.
// 여기서 크게 벗어나면 인물이 프레임 안에서 커지거나 작아져 하단에 흰 여백이 생긴다.
// FACE_W=0.225 → 두 인물 모두 허벅지 크롭이 캔버스 하단을 넘겨 채운다.
// CHEEK_Y=0.235 → 머리가 가장 높은 미아(포니테일)도 정수리가 잘리지 않는다.
export const REPORTER_SPEC = {
  W: 900,
  H: 1350,
  CHEEK_Y: 0.235,  // 광대선(눈높이 근처) y 위치 (캔버스 높이 비율)
  FACE_W: 0.225,   // 얼굴 광대폭 (캔버스 가로 비율)
};

const BG_THRESH = 240; // 이보다 밝으면 배경(흰색)으로 간주

/** 창백한 애니 피부톤 판정 — 흰 셔츠/배경, 머리카락, 옷과 구분된다 */
function isSkin(r, g, b) {
  return r > 205 && r <= 255 && g > 160 && b > 135 &&
    r >= g && g >= b && (r - b) >= 18 && (r - b) <= 80;
}

/** 실루엣 측정: bbox + 어깨행 추정 */
export async function measure(file) {
  const img = sharp(file).ensureAlpha();
  const { width: W, height: H } = await img.metadata();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });

  const rows = new Array(H);
  let minX = W, maxX = -1, minY = H, maxY = -1;

  for (let y = 0; y < H; y++) {
    let l = -1, r = -1, sl = -1, sr = -1, sn = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r8 = data[i], g8 = data[i + 1], b8 = data[i + 2];
      const isBg = data[i + 3] < 16 || (r8 >= BG_THRESH && g8 >= BG_THRESH && b8 >= BG_THRESH);
      if (!isBg) { if (l < 0) l = x; r = x; }
      if (data[i + 3] >= 16 && isSkin(r8, g8, b8)) { if (sl < 0) sl = x; sr = x; sn++; }
    }
    rows[y] = { l, r, w: r < 0 ? 0 : r - l + 1, sl, sr, sn };
    if (r >= 0) {
      if (y < minY) minY = y;
      maxY = y;
      if (l < minX) minX = l;
      if (r > maxX) maxX = r;
    }
  }

  // 광대선: "최상단 피부 덩어리(=얼굴)" 안에서 피부 픽셀 수가 가장 많은 행.
  //
  // 단순히 상단 45%에서 최대폭 행을 찾으면 팔·손·목 피부가 합산돼 가슴까지 내려간다
  // (미아 실측 37%, 실제 얼굴은 20%). 그래서 이마(첫 유효 피부행)부터 얼굴 한 개 높이
  // 만큼만 훑는다.
  const minSkin = Math.round(W * 0.02); // 노이즈 컷
  let foreheadY = -1;
  for (let y = minY; y < Math.round(H * 0.45); y++) {
    if (rows[y].sn >= minSkin) { foreheadY = y; break; }
  }
  const bandEnd = Math.min(Math.round(H * 0.45), foreheadY + Math.round(H * 0.11));
  let cheekY = -1, best = 0;
  for (let y = foreheadY; y >= 0 && y < bandEnd; y++) {
    if (rows[y].sn > best) { best = rows[y].sn; cheekY = y; }
  }
  const faceL = cheekY < 0 ? -1 : rows[cheekY].sl;
  const faceR = cheekY < 0 ? -1 : rows[cheekY].sr;
  const faceW = cheekY < 0 ? 0 : faceR - faceL + 1;

  return { file, W, H, minX, maxX, minY, maxY, cheekY, faceL, faceR, faceW, rows };
}

function report(m) {
  const pct = (v, of) => `${(v / of * 100).toFixed(1)}%`;
  console.log(`\n=== ${m.file} (${m.W}x${m.H}) ===`);
  console.log(`  bbox        x ${m.minX}..${m.maxX} / y ${m.minY}..${m.maxY}`);
  console.log(`  정수리       y=${m.minY} (${pct(m.minY, m.H)})`);
  console.log(`  광대선       y=${m.cheekY} (${pct(m.cheekY, m.H)})   ← 수직 기준`);
  console.log(`  얼굴 광대폭  ${m.faceW}px (${pct(m.faceW, m.W)})  x ${m.faceL}..${m.faceR}  ← 스케일 기준`);
  console.log(`  얼굴 중심x   ${pct((m.faceL + m.faceR) / 2, m.W)}`);
  console.log(`  실루엣 중심x ${pct((m.minX + m.maxX) / 2, m.W)}`);
}

/** 검출 결과 확인용: 광대선·얼굴폭에 마커를 그린 PNG */
async function diag(src, dst) {
  const m = await measure(src);
  report(m);
  const line = Buffer.from(
    `<svg width="${m.W}" height="${m.H}">
       <rect x="0" y="${m.cheekY - 2}" width="${m.W}" height="4" fill="red" opacity="0.8"/>
       <rect x="${m.faceL}" y="0" width="3" height="${m.H}" fill="lime" opacity="0.8"/>
       <rect x="${m.faceR}" y="0" width="3" height="${m.H}" fill="lime" opacity="0.8"/>
       <rect x="0" y="${m.minY}" width="${m.W}" height="3" fill="blue" opacity="0.8"/>
     </svg>`);
  await sharp(src).composite([{ input: line }]).png().toFile(dst);
  console.log(`  → 진단 이미지 ${dst} (빨강=광대선, 초록=얼굴폭, 파랑=정수리)`);
}

/** 규격에 맞춰 스케일·이동 후 캔버스에 합성 (기본으로 배경 알파 컷까지 수행) */
async function align(src, dst, nudge = 1, doAlpha = true) {
  const S = REPORTER_SPEC;
  const m = await measure(src);
  report(m);

  if (m.cheekY < 0 || m.faceW <= 0) throw new Error(`얼굴 검출 실패: ${src}`);

  const scale = (S.W * S.FACE_W / m.faceW) * nudge;
  const newW = Math.round(m.W * scale);
  const newH = Math.round(m.H * scale);

  // 스케일 후 좌표계에서 광대선과 얼굴 중심을 목표 위치로 이동
  const top = Math.round(S.H * S.CHEEK_Y - m.cheekY * scale);
  const left = Math.round(S.W / 2 - ((m.faceL + m.faceR) / 2) * scale);

  // sharp의 composite는 캔버스보다 큰 입력과 음수 좌표를 받지 못한다.
  // 그래서 캔버스에 실제로 들어가는 영역만 미리 잘라내고, 좌표는 0 이상으로 클램프한다.
  const sx = Math.max(0, -left);
  const sy = Math.max(0, -top);
  const dx = Math.max(0, left);
  const dy = Math.max(0, top);
  const sw = Math.min(newW - sx, S.W - dx);
  const sh = Math.min(newH - sy, S.H - dy);
  if (sw <= 0 || sh <= 0) throw new Error(`정렬 결과가 캔버스를 벗어남: ${src}`);

  const resized = await sharp(src)
    .resize(newW, newH)
    .extract({ left: sx, top: sy, width: sw, height: sh })
    .png()
    .toBuffer();

  const composed = await sharp({ create: { width: S.W, height: S.H, channels: 4, background: '#ffffff' } })
    .composite([{ input: resized, top: dy, left: dx }])
    .png()
    .toBuffer();

  console.log(`  정렬  scale=${scale.toFixed(4)}${nudge !== 1 ? ` (nudge ${nudge})` : ''} top=${top} left=${left}`);
  if (doAlpha) await alphaCut(composed, dst, `${src} (정렬본)`);
  else await sharp(composed).toFile(dst);

  const a = await measure(dst);
  console.log(`  검증: 광대선 ${(a.cheekY / S.H * 100).toFixed(1)}% (목표 ${(S.CHEEK_Y * 100).toFixed(1)}) / 얼굴폭 ${(a.faceW / S.W * 100).toFixed(1)}% (목표 ${(S.FACE_W * 100).toFixed(1)}) / 정수리 ${(a.minY / S.H * 100).toFixed(1)}%`);
}

/* 배경 알파 컷 — 가장자리에서 플러드필로 "바깥" 배경만 지운다.
 *
 * 단순 흰색 제거(색 기준 일괄 투명화)는 절대 쓰면 안 된다. 이 캐릭터들은 화이트 셔츠를
 * 입고 있어서 셔츠가 통째로 날아간다. 바깥 배경만 지우려면 "프레임 가장자리와 연결된
 * 밝은 영역"이라는 위치 조건이 필요하고, 그건 플러드필로만 판정된다.
 *
 * 임계값 두 개(히스테리시스):
 *   FILL  — 이보다 밝으면 배경으로 보고 전파한다(확실한 배경)
 *   EDGE  — FILL~EDGE 사이는 경계 안티에일리어싱으로 보고 부분 알파를 준다
 *           (머리카락 끝 등 반투명 픽셀이 하드하게 잘리는 것을 막는다)
 */
const ALPHA_FILL = 244;
const ALPHA_EDGE = 224;
// 원본 배경이 순백이 아니라 아주 연한 회색이라, 경계 안티에일리어싱 픽셀이 FILL 임계값
// 아래로 살아남아 실루엣에 흰 테두리(할로)가 남는다. 그래서 플러드필 후 "배경에 닿은
// 밝은 픽셀"을 몇 겹 깎아낸다. 셔츠는 바깥과 연결돼 있지 않아 침식되지 않는다.
const ALPHA_RIM = 232;   // 이보다 밝고 배경에 닿아 있으면 테두리로 보고 깎는다
const ALPHA_RIM_PASSES = 2;

async function alphaCut(src, dst, label = src) {
  const { data, info } = await sharp(src).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const bright = (i) => Math.min(data[i], data[i + 1], data[i + 2]);

  // 1) 가장자리에서 시작해 밝은 영역을 4방향 전파
  const bg = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (bg[p]) return;
    if (bright(p * 4) < ALPHA_FILL) return;
    bg[p] = 1; stack.push(p);
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  // 1-b) 흰 테두리 침식: 배경에 닿은 밝은 픽셀을 ALPHA_RIM_PASSES 겹 배경으로 흡수
  let rim = 0;
  for (let k = 0; k < ALPHA_RIM_PASSES; k++) {
    const add = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (bg[p] || bright(p * 4) < ALPHA_RIM) continue;
        if ((x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) ||
            (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W])) add.push(p);
      }
    }
    for (const p of add) bg[p] = 1;
    rim += add.length;
    if (!add.length) break;
  }

  // 2) 알파 적용: 배경=0, 배경에 인접한 밝은 픽셀=부분 알파, 나머지=255
  let cut = 0, soft = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      if (bg[p]) { data[i + 3] = 0; cut++; continue; }
      const b = bright(i);
      if (b <= ALPHA_EDGE) { data[i + 3] = 255; continue; }
      const touching =
        (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) ||
        (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W]);
      if (!touching) { data[i + 3] = 255; continue; }
      data[i + 3] = Math.round(255 * (ALPHA_FILL - b) / (ALPHA_FILL - ALPHA_EDGE));
      soft++;
    }
  }

  // 3) 남은 밝은 불투명 영역 보고 — 대부분 화이트 셔츠 하이라이트(정상)다.
  //    배경 흰색과 셔츠 흰색은 색으로 구분되지 않으므로 자동 판정하지 않고 좌표만 알린다.
  //    팔·몸통 사이가 뚫렸는지는 결과를 색 배경에 올려 눈으로 확인하는 것이 확실하다.
  const seen = new Uint8Array(W * H);
  const holes = [];
  for (let p = 0; p < W * H; p++) {
    if (bg[p] || seen[p] || bright(p * 4) < ALPHA_FILL) continue;
    let n = 0, minX = W, maxX = -1, minY = H, maxY = -1;
    const st = [p]; seen[p] = 1;
    while (st.length) {
      const q = st.pop(); const qx = q % W, qy = (q - qx) / W;
      n++;
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      for (const r of [qx > 0 ? q - 1 : -1, qx < W - 1 ? q + 1 : -1,
                       qy > 0 ? q - W : -1, qy < H - 1 ? q + W : -1]) {
        if (r < 0 || seen[r] || bg[r] || bright(r * 4) < ALPHA_FILL) continue;
        seen[r] = 1; st.push(r);
      }
    }
    if (n >= 200) holes.push({ n, minX, maxX, minY, maxY });
  }
  holes.sort((a, b) => b.n - a.n);

  await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(dst);
  console.log(`\n=== 알파 컷 ${label} → ${dst} ===`);
  console.log(`  배경 제거 ${cut}px (${(cut / (W * H) * 100).toFixed(1)}%), 테두리 침식 ${rim}px, 소프트 엣지 ${soft}px`);
  console.log(`  남은 밝은 불투명 영역 ${holes.length}개 (대개 화이트 셔츠 하이라이트, 상위 3개):`);
  for (const h of holes.slice(0, 3)) {
    console.log(`    ${h.n}px  x ${h.minX}..${h.maxX} y ${h.minY}..${h.maxY}`);
  }
  console.log(`  팔·몸통 사이가 뚫렸는지는 색 배경에 올려 눈으로 확인할 것`);
}

/** 정렬 검증용: 정렬된 베이스들을 나란히 놓고 기준선을 그린 시트 */
async function sheet(files, dst) {
  const S = REPORTER_SPEC;
  const n = files.length;
  const guides = [S.CHEEK_Y, 0.5, 0.75].map(p =>
    `<rect x="0" y="${Math.round(S.H * p) - 1}" width="${S.W * n}" height="3" fill="${p === S.CHEEK_Y ? 'red' : 'deepskyblue'}" opacity="0.7"/>`).join('');
  const centers = files.map((_, i) =>
    `<rect x="${i * S.W + S.W / 2 - 1}" y="0" width="2" height="${S.H}" fill="lime" opacity="0.5"/>`).join('');

  await sharp({ create: { width: S.W * n, height: S.H, channels: 4, background: '#ffffff' } })
    .composite([
      ...files.map((f, i) => ({ input: f, left: i * S.W, top: 0 })),
      { input: Buffer.from(`<svg width="${S.W * n}" height="${S.H}">${guides}${centers}</svg>`) },
    ])
    .png()
    .toFile(dst);
  console.log(`→ 검증 시트 ${dst} (빨강=광대선 기준, 하늘=50%/75%, 초록=가로 중앙)`);
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };

if (argv.includes('--measure')) {
  for (const f of argv.slice(argv.indexOf('--measure') + 1)) report(await measure(f));
} else if (argv.includes('--alpha')) {
  const [src, dst] = argv.slice(argv.indexOf('--alpha') + 1);
  await alphaCut(src, dst);
} else if (argv.includes('--sheet')) {
  const rest = argv.slice(argv.indexOf('--sheet') + 1);
  await sheet(rest.slice(0, -1), rest[rest.length - 1]);
} else if (argv.includes('--diag')) {
  const [src, dst] = argv.slice(argv.indexOf('--diag') + 1);
  await diag(src, dst);
} else {
  const src = flag('--in'), dst = flag('--out');
  if (!src || !dst) {
    console.error('usage:\n' +
      '  --in <src> --out <dst> [--scale-nudge 1.0] [--no-alpha]   규격 정렬 + 배경 알파 컷\n' +
      '  --measure <img>...                                        실루엣·얼굴 측정\n' +
      '  --diag <src> <dst>                                        검출 마커 이미지\n' +
      '  --alpha <src> <dst>                                       배경 알파 컷만\n' +
      '  --sheet <img>... <dst>                                    정렬 검증 시트');
    process.exit(1);
  }
  await align(src, dst, Number(flag('--scale-nudge') ?? 1), !argv.includes('--no-alpha'));
}
