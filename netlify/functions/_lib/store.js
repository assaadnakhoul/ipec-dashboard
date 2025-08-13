// netlify/functions/_lib/store.js
import { getStore as _getStore } from '@netlify/blobs';

export const STORE_NAME   = process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache';
export const STATE_KEY    = 'build/state.json';
export const CHUNK_PREFIX = 'build/chunks/';
export const AGG_KEY      = 'agg.json';

// Make a store that works across blobs lib versions (siteId vs siteID)
export function store() {
  const token  = process.env.NETLIFY_BLOBS_TOKEN;
  const siteId = process.env.NETLIFY_BLOBS_SITE_ID;

  // Try both spellings; whichever the lib expects will be used.
  const opts1 = { siteId, token };
  const opts2 = { siteID: siteId, token };

  // First attempt (most libs use siteId)
  try {
    return _getStore(STORE_NAME, opts1);
  } catch (_) {
    // Fallback attempt (some examples use siteID)
    return _getStore(STORE_NAME, opts2);
  }
}

// Convenience helpers
export async function readJSON(key, def = null) {
  try {
    const v = await store().get(key, { type: 'json' });
    return v ?? def;
  } catch {
    return def;
  }
}

export async function writeJSON(key, obj) {
  await store().setJSON(key, obj);
}

export async function deleteByPrefix(prefix) {
  const s = store();
  if (!s.list) return;
  for await (const { key } of s.list({ prefix })) await s.delete(key);
}
