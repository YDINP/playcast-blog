// 프리뷰 빌드 후처리 — Astro base 가 처리하지 못한 '루트 절대경로'에 접두어를 붙인다.
//
// 왜 필요한가: frontmatter 의 thumbnail:"/games/x.jpg" 처럼 **문자열로 하드코딩된 경로**는
// Astro 가 base 를 안 붙인다(컴포넌트가 그대로 출력). CSS/JS 번들은 base 가 붙는데 이미지만
// 안 붙어서, 미디어 서버 하위에서 열면 이미지가 전부 404 가 된다.
//
//   node scripts/prefix-preview-assets.mjs <distDir> <base>
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2];
const base = (process.argv[3] || '').replace(/\/$/, '');
if (!dist || !base) { console.error('usage: node prefix-preview-assets.mjs <distDir> <base>'); process.exit(2); }

// ⚠️ src/href 속성만 훑으면 **씬 이미지를 통째로 놓친다.** 시청 페이지는 씬 배경을
//    `style="background-image:url(&#34;/games/scenes/....jpg&#34;)"` 와
//    `<script type="application/json">{"scenes":[{"image":"/games/scenes/...jpg"...`
//    두 군데에 넣는데 둘 다 속성이 아니다. 실제로 이걸 놓쳐 페이지마다 404 가 났다.
//    → 따옴표류(" ' ( &#34;) 뒤에 오는 루트 절대경로를 전부 잡는다.
//    base 는 '/public/playcast' 로 끝나므로 이미 접두된 경로 앞은 따옴표가 아니다 → 이중 적용 없음.
const DIRS = ['games', 'host', 'js', 'watch', 'genre', 'about', 'favicon.svg', 'rss.xml'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = new RegExp(`(["'(]|&#34;)/(${DIRS.map(esc).join('|')})`, 'g');

let files = 0, hits = 0;
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.html$/i.test(n)) continue;
    const s = readFileSync(p, 'utf8');
    let c = 0;
    const out = s.replace(re, (m, a, b) => { c++; return `${a}${base}/${b}`; });
    if (c) { writeFileSync(p, out); files++; hits += c; }
  }
})(dist);
console.log(`후처리 완료: ${files}개 HTML, ${hits}개 경로에 접두어 적용`);
