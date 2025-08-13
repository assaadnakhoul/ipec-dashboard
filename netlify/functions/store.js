// netlify/functions/store.js
import { getStore } from '@netlify/blobs';

export const STORE_NAME   = process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache';
export const STATE_KEY    = 'build/state.json';
export const CHUNK_PREFIX = 'build/chunks/';
export const AGG_KEY      = 'agg.json';

export function store() {
  return getStore(STORE_NAME, {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token:  process.env.NETLIFY_BLOBS_TOKEN,
  });
}

export async function readJSON(key, def=null) {
  try { return (await store().get(key, { type: 'json' })) ?? def; }
  catch { return def; }
}
export async function writeJSON(key, obj) { await store().setJSON(key, obj); }
export async function deleteByPrefix(prefix) {
  const s = store();
  if (!s.list) return;
  for await (const { key } of s.list({ prefix })) await s.delete(key);
}
