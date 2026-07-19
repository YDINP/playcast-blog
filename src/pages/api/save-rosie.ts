export const prerender = false;

import type { APIRoute } from 'astro';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

// 마지막 저장상태 반환(에디터 로드 시 이어서 조정)
export const GET: APIRoute = async () => {
  try {
    const txt = await readFile('.tmp/rosie-editor-state.json', 'utf8');
    return new Response(txt, { headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response('null', { headers: { 'Content-Type': 'application/json' } });
  }
};

// 로지 에디터 저장 엔드포인트(로컬 dev 전용).
//  - .tmp/rosie-editor-state.json : 조정값(Claude가 읽어 rosie.png 재현/미세조정)
//  - public/host/rosie.png        : 캔버스 합성 결과를 그대로 적용(WYSIWYG)
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { state, png } = body ?? {};
    await mkdir('.tmp', { recursive: true });
    await writeFile('.tmp/rosie-editor-state.json', JSON.stringify(state ?? {}, null, 2), 'utf8');
    let applied = false;
    if (typeof png === 'string' && png.startsWith('data:image/png')) {
      const b64 = png.replace(/^data:image\/png;base64,/, '');
      await writeFile('public/host/rosie.png', Buffer.from(b64, 'base64'));
      applied = true;
    }
    return new Response(JSON.stringify({ ok: true, applied }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
