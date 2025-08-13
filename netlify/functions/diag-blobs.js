// netlify/functions/diag-blobs.js
import { store } from './_lib/store.js';

export const handler = async () => {
  const envSeen = {
    NETLIFY_BLOBS_SITE_ID: !!process.env.NETLIFY_BLOBS_SITE_ID,
    NETLIFY_BLOBS_TOKEN:   !!process.env.NETLIFY_BLOBS_TOKEN,
    NETLIFY_BLOBS_STORE:   process.env.NETLIFY_BLOBS_STORE || '(not set)',
  };

  try {
    const s = store();
    const key = 'diag/test.json';
    await s.setJSON(key, { ok: true, t: Date.now() });
    const back = await s.get(key, { type: 'json' });
    return json({ ok: true, envSeen, writeReadWorked: !!back?.ok });
  } catch (e) {
    return json({ ok: false, envSeen, error: e.message }, 500);
  }
};

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body, null, 2),
  };
}
