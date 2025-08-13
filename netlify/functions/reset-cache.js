// netlify/functions/reset-cache.js
// netlify/functions/get-agg.js
import { store, readJSON, AGG_KEY, STATE_KEY } from './_lib/store.js';

export const handler = async () => {
  try {
    const s = store();
    await Promise.allSettled([
      s.delete(STATE_KEY),
      s.delete(AGG_KEY),
    ]);
    await deleteByPrefix(CHUNK_PREFIX);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, cleared: true }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  }
};
