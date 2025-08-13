// netlify/functions/diag-blobs.js
import { store } from './store.js';

export const handler = async () => {
  try {
    const hasSite = !!process.env.NETLIFY_BLOBS_SITE_ID;
    const hasTok  = !!process.env.NETLIFY_BLOBS_TOKEN;

    const s = store();
    const testKey = 'diag/test.json';
    await s.setJSON(testKey, { ok: true, t: Date.now() });
    const back = await s.get(testKey, { type: 'json' });

    return json({
      ok: true,
      env: { NETLIFY_BLOBS_SITE_ID: hasSite, NETLIFY_BLOBS_TOKEN: hasTok },
      writeReadWorked: !!back?.ok
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
};

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
