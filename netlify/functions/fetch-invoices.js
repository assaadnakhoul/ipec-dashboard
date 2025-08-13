// netlify/functions/fetch-invoices.js
// Returns the final aggregated payload directly (legacy endpoint used by UI)
import { readJSON, AGG_KEY } from './store.js';

export const handler = async () => {
  try {
    const agg = await readJSON(AGG_KEY, null);
    if (!agg) {
      return {
        statusCode: 404,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ ok: false, message: 'Aggregation not ready yet.' }),
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
