#!/usr/bin/env node
/* 이미지 생성 CLI — 본인 API 키 직접 호출(힉스필드/디렉티브 비의존).
 *
 *   node tools/gen-image.mjs --provider gemini|openai --out <path> --prompt "..."
 *
 * 키는 환경변수에서만 읽는다(평문 인자 금지):
 *   GEMINI_API_KEY   (Google AI Studio)
 *   OPENAI_API_KEY   (platform.openai.com)
 *
 * 생성 결과(base64)를 디코드해 --out 경로에 원본 저장. 리사이즈는 별도 단계.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 키 로더: 환경변수에 없으면 gitignore된 .imagegen.env(KEY=VALUE 라인)에서 읽는다.
// (User 환경변수는 실행 중 세션에 즉시 반영 안 되므로 파일 방식이 편리·안전)
(function loadKeyFile() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const f = path.join(root, '.imagegen.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const provider = arg('provider');
const prompt = arg('prompt');
const out = arg('out');
if (!provider || !prompt || !out) {
  console.error('usage: --provider gemini|openai --out <path> --prompt "..."');
  process.exit(2);
}
fs.mkdirSync(path.dirname(out), { recursive: true });

async function gemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 환경변수 없음');
  const model = arg('model', 'gemini-2.5-flash-image');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData || p.inline_data);
  const b64 = (img?.inlineData || img?.inline_data)?.data;
  if (!b64) throw new Error('Gemini 응답에 이미지 없음: ' + JSON.stringify(j).slice(0, 300));
  return Buffer.from(b64, 'base64');
}

async function openai() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 환경변수 없음');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: arg('model', 'gpt-image-1'),
      prompt,
      size: arg('size', '1536x1024'),
      quality: arg('quality', 'medium'),
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI 응답에 이미지 없음: ' + JSON.stringify(j).slice(0, 300));
  return Buffer.from(b64, 'base64');
}

try {
  const buf = provider === 'gemini' ? await gemini() : await openai();
  fs.writeFileSync(out, buf);
  console.log(`OK ${provider} -> ${out} (${(buf.length / 1024).toFixed(0)}KB)`);
} catch (e) {
  console.error('FAIL', e.message);
  process.exit(1);
}
