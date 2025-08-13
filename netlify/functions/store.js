// netlify/functions/store.js
import { getStore } from '@netlify/blobs';

export const STORE_NAME   = process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache';
export const STATE_KEY    = 'build/state.json';
export const CHUNK_PREFIX = 'build/chunks/';
export const AGG_KEY      = 'agg.json';

export function store() {
  return getStore(STORE_NAME, {
    siteID: process.env.NETLIFY_BLOBS_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN,
  });
}

export async function readJSON(key, def = null) {
  try {
    const s = store();
    const v = await s.get(key, { type: 'json' });
    return v ?? def;
  } catch {
    return def;
  }
}

export async function writeJSON(key, obj) {
  const s = store();
  await s.setJSON(key, obj);
}

// Best-effort cleanup of a prefix (requires @netlify/blobs >= 6)
export async function deleteByPrefix(prefix) {
  const s = store();
  if (!s.list) return;
  for await (const { key } of s.list({ prefix })) {
    await s.delete(key);
  }
}
