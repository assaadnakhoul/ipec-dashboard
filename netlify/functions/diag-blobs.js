// netlify/functions/diag-blobs.js
export const handler = async () => {
  const envSeen = {
    NETLIFY_BLOBS_SITE_ID: !!process.env.NETLIFY_BLOBS_SITE_ID,
    NETLIFY_BLOBS_TOKEN:   !!process.env.NETLIFY_BLOBS_TOKEN,
    NETLIFY_BLOBS_STORE:   process.env.NETLIFY_BLOBS_STORE || '(not set)',
  };

  // DO NOT import './store.js' yet; report env first
  // If both present, then try a simple write/read
  let writeReadWorked = null;
  let err = null;

  try {
    if (envSeen.NETLIFY_BLOBS_SITE_ID && envSeen.NETLIFY_BLOBS_TOKEN) {
      const { getStore } = await import('@netlify/blobs');
      const s = getStore(process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache', {
        siteID: process.env.NETLIFY_BLOBS_SITE_ID,
        token:  process.env.NETLIFY_BLOBS_TOKEN,
      });
      const key = 'diag/test.json';
      await s.setJSON(key, { ok: true, t: Date.now() });
      const back = await s.get(key, { type: 'json' });
      writeReadWorked = !!back?.ok;
    }
  } catch (e) {
    err = e.message || String(e);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ ok: true, envSeen, writeReadWorked, err }, null, 2),
  };
};
