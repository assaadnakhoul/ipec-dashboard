// netlify/functions/fetch-invoices.js
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'ipec-dashboard-cache';
const AGG_KEY = 'agg.json';

function store() {
  return getStore(STORE_NAME, {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

export const handler = async () => {
  try {
    const s = store();
    const agg = await s.get(AGG_KEY, { type: 'json' });
    if (!agg) {
      return {
        statusCode: 404,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({
          ok: false,
          message: 'No cache yet. Visit /.netlify/functions/warm-cache repeatedly until done: true',
        }),
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(agg),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
