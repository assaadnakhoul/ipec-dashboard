// get-agg.js — returns dashboard data if ready, otherwise {ready:false}
import { getStore } from '@netlify/blobs';

export const handler = async () => {
  try {
    const store = getStore('ipec-cache');
    const state = await store.get('state.json', { type: 'json' });
    if (!state || !state.done) {
      // let the UI know the cache is not complete yet
      return resp({ ready: false });
    }
    // strip heavy internal fields before sending to client
    const { data } = state;
    return resp({ ready: true, data });
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
