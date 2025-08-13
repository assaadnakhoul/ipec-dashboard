// netlify/functions/get-agg.js
import { store } from './_store.js';

const AGG_KEY = 'agg.json';
const STATE_KEY = 'state.json'; // or 'build/state.json'

export const handler = async () => {
  try {
    const s = store();
    const state = await s.get(STATE_KEY, { type: 'json' });
    const agg   = await s.get(AGG_KEY,   { type: 'json' });

    if (!state || !state.done || !agg) {
      return resp({ ready: false });
    }
    return resp({ ready: true, data: agg });
  } catch (e) {
    return resp({ ready: false, error: e.message }, 200);
  }
};

function resp(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
