// netlify/functions/_store.js
import { getStore } from '@netlify/blobs';

export function store() {
  return getStore(process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache', {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}
