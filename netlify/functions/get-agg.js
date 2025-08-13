// netlify/functions/get-agg.js
import { store, readJSON, AGG_KEY, STATE_KEY } from './_lib/store.js';

export const handler = async () => {
  try {
    // Ensure Blobs are reachable (early fail helps)
    await store();

    const state = await readJSON(STATE_KEY, null);
    const agg   = await readJSON(AGG_KEY,   null);

    if (!state || !state.done || !agg) {
      return json({ ready: false });
    }
    return json({ ready: true, data: agg });
  } catch (e) {
    return json({ ready: false, error: e.message });
  }
};

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
