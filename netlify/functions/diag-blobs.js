import { store } from './_lib/store.js';

export const handler = async () => {
  const envSeen = {
    NETLIFY_BLOBS_SITE_ID: !!process.env.NETLIFY_BLOBS_SITE_ID,
    NETLIFY_BLOBS_TOKEN:   !!process.env.NETLIFY_BLOBS_TOKEN,
    NETLIFY_BLOBS_STORE:   process.env.NETLIFY_BLOBS_STORE || '(not set)',
    blobsPkg: (() => {
      try { return require('@netlify/blobs/package.json').version; }
      catch { return '(unknown)'; }
    })()
  };

  try {
    const s = store();
    const key = 'diag/test.json';
    await s.setJSON(key, { ok: true, t: Date.now() });
    const back = await s.get(key, { type: 'json' });
    return respond(200, { ok: true, envSeen, writeReadWorked: !!back?.ok });
  } catch (e) {
    return respond(500, { ok: false, envSeen, error: e.message });
  }
};

function respond(code, body) {
  return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) };
}
