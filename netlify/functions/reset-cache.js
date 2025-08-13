// netlify/functions/reset-cache.js
import { getStore } from '@netlify/blobs';
export const handler = async () => {
  try {
    const store = getStore('ipec-dash');
    await Promise.all([
      store.delete('progress.json'),
      store.delete('agg-work.json'),
      store.delete('agg.json'),
    ]);
    return { statusCode: 200, body: JSON.stringify({ ok:true, cleared:true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
