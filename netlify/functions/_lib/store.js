// netlify/functions/_lib/store.js
// Drive-backed cache: readJSON / writeJSON / deleteByPrefix
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';

export const STORE_NAME   = 'gdrive-cache'; // label only (not used)
export const STATE_KEY    = 'build/state.json';
export const CHUNK_PREFIX = 'build/chunks/';
export const AGG_KEY      = 'agg.json';

function makeAuth() {
  const saEmail = process.env.GDRIVE_SA_EMAIL;
  const saKey   = process.env.GDRIVE_SA_KEY;
  if (!saEmail || !saKey) throw new Error('Missing GDRIVE_SA_EMAIL or GDRIVE_SA_KEY');
  const creds = JSON.parse(saKey);
  return new JWT({
    email: saEmail || creds.client_email,
    key: creds.private_key,
    // FULL drive scope so we can list/create/update in the cache folder
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

function drive() {
  return google.drive({ version: 'v3', auth: makeAuth() });
}

function cacheFolderId() {
  const id = process.env.GDRIVE_CACHE_FOLDER_ID;
  if (!id) throw new Error('Missing GDRIVE_CACHE_FOLDER_ID (set it to your cache folder ID)');
  return id;
}

// Map keys like "build/chunks/0.json" -> "build__chunks__0.json" (flat names in one folder)
const keyToName = (key) => key.replace(/[\\/]/g, '__');

async function findFileIdByName(d, parentId, name) {
  let pageToken = null;
  do {
    const res = await d.files.list({
      q: `'${parentId}' in parents and name='${name}' and trashed=false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 100,
      pageToken,
    });
    const files = res.data.files || [];
    if (files.length) return files[0].id;
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return null;
}

export async function readJSON(key, def = null) {
  const d = drive();
  const parentId = cacheFolderId();
  const name = keyToName(key);

  const fileId = await findFileIdByName(d, parentId, name);
  if (!fileId) return def;

  const res = await d.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  try {
    return JSON.parse(Buffer.from(res.data).toString('utf8'));
  } catch {
    return def;
  }
}

export async function writeJSON(key, obj) {
  const d = drive();
  const parentId = cacheFolderId();
  const name = keyToName(key);

  let fileId = await findFileIdByName(d, parentId, name);
  const media = { mimeType: 'application/json', body: JSON.stringify(obj) };

  if (!fileId) {
    const createRes = await d.files.create({
      requestBody: { name, parents: [parentId], mimeType: 'application/json' },
      media,
      fields: 'id',
    });
    fileId = createRes.data.id;
  } else {
    await d.files.update({ fileId, media });
  }
  return true;
}

export async function deleteByPrefix(prefix) {
  const d = drive();
  const parentId = cacheFolderId();
  const mapped = keyToName(prefix);

  let pageToken = null;
  do {
    const res = await d.files.list({
      q: `'${parentId}' in parents and mimeType='application/json' and trashed=false`,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 1000,
      pageToken,
    });
    const files = res.data.files || [];
    const toDelete = files.filter(f => f.name.startsWith(mapped));
    for (const f of toDelete) {
      await d.files.delete({ fileId: f.id }).catch(() => {});
    }
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
}

// Kept for compatibility (some functions call store() just to “touch” the cache)
export function store() {
  // If we can fetch the folder ID and make an auth client, we’re “reachable”.
  cacheFolderId(); makeAuth();
  return { driver: 'gdrive' };
}
