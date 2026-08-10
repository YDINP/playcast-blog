#!/usr/bin/env node
/**
 * thumb-title-batch.mjs — scripts/thumb-titles.json 의 표시명을 각 편 썸네일에 일괄로 얹는다.
 *
 *   node scripts/thumb-title-batch.mjs [--dry] [--only <slug>]
 *
 * ⚠️ 두 번 돌리면 글자가 겹쳐 찍힌다. 다시 얹으려면 먼저 원본을 되돌릴 것:
 *      git checkout <제목 적용 전 커밋> -- public/games
 * 정렬(로지 반대쪽)은 thumb-title.mjs 의 --align auto 가 민트 머리 질량으로 판정한다.
 * 판정 로그(mint L/R)를 남기므로, 배경 시안 이펙트에 오판한 편은 로그를 보고 손으로 고친다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const map = JSON.parse(readFileSync('scripts/thumb-titles.json', 'utf8'));

// 밑줄로 시작하는 파일은 초안이라 빌드에 안 들어간다 — 표지도 건드리지 않는다.
const posts = readdirSync('src/videos')
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .map((f) => {
    const t = readFileSync(`src/videos/${f}`, 'utf8');
    const m = t.match(/^thumbnail:\s*"?([^"\n]+)"?\s*$/m);
    return { slug: f.replace('.md', ''), thumb: m ? m[1].trim().replace(/"$/, '') : '' };
  })
  .filter((p) => p.thumb.startsWith('/games/'));

let done = 0;
let skipped = 0;
for (const p of posts) {
  // 값이 문자열이면 제목만, 객체면 자동 판정을 덮어쓰는 배치 지정({title, align, y})이다.
  const entry = map[p.slug];
  const title = typeof entry === 'string' ? entry : entry?.title;
  const align = (typeof entry === 'object' && entry.align) || 'auto';
  const y = typeof entry === 'object' ? entry.y : undefined;
  if (!title || (only && p.slug !== only)) {
    skipped++;
    continue;
  }
  const file = `public${p.thumb}`;
  if (!existsSync(file)) {
    console.log(`SKIP ${p.slug} — no file ${file}`);
    skipped++;
    continue;
  }
  if (dry) {
    console.log(`DRY  ${p.slug} :: "${title}" -> ${file}`);
    done++;
    continue;
  }
  const argv = ['scripts/thumb-title.mjs', '--in', file, '--out', file, '--title', title, '--align', align];
  if (y !== undefined) argv.push('--y', String(y));
  const out = execFileSync(process.execPath, argv, { encoding: 'utf8' });
  console.log(`${p.slug.padEnd(46)} ${out.trim()}`);
  done++;
}
console.log(`\n${dry ? 'DRY ' : ''}done=${done} skipped=${skipped}`);
