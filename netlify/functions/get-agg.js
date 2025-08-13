// netlify/functions/get-agg.js
import { getStore } from '@netlify/blobs';

export const handler = async () => {
  try {
    const store = getStore('ipec-dash');
    const agg = await store.get('agg.json', { type: 'json' });
    if (!agg) {
      const progress = await store.get('progress.json', { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ready: false, progress: progress || null }),
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ ready: true, data: agg }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
