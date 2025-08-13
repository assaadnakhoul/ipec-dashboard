import { getStore as _getStore } from '@netlify/blobs';

export const STORE_NAME   = process.env.NETLIFY_BLOBS_STORE || 'ipec-dashboard-cache';
export const STATE_KEY    = 'build/state.json';
export const CHUNK_PREFIX = 'build/chunks/';
export const AGG_KEY      = 'agg.json';

/**
 * Works across blobs versions by trying both option spellings.
 * First try the modern `siteId`, then fallback to `siteID`.
 */
export function store() {
  const token  = process.env.NETLIFY_BLOBS_TOKEN;
  const siteId = process.env.NETLIFY_BLOBS_SITE_ID;

  // If either is missing, throw early with a clear error
  if (!token || !siteId) {
    throw new Error(
      'Missing NETLIFY_BLOBS_SITE_ID or NETLIFY_BLOBS_TOKEN in environment.'
    );
  }

  try {
    // Preferred option name
    return _getStore(STORE_NAME, { siteId, token });
  } catch {
    // Fallback for older builds
    return _getStore(STORE_NAME, { siteID: siteId, token });
  }
}

export async function readJSON(key, def = null) {
  try { return (await store().get(key, { type: 'json' })) ?? def; }
  catch { return def; }
}
export async function writeJSON(key, obj) { await store().setJSON(key, obj); }
export async function deleteByPrefix(prefix) {
  const s = store();
  if (!s.list) return;
  for await (const { key } of s.list({ prefix })) await s.delete(key);
}
