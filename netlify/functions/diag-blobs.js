// netlify/functions/diag-blobs.js
import { writeJSON, readJSON } from './_lib/store.js';

export const handler = async () => {
  try {
    // write test
    await writeJSON('diag.json', { ok: true, t: Date.now() });
    // read test
    const back = await readJSON('diag.json', null);

    return respond(200, {
      ok: !!back?.ok,
      using: 'google-drive-cache',
      seen: {
        GDRIVE_SA_EMAIL: !!process.env.GDRIVE_SA_EMAIL,
        GDRIVE_SA_KEY: !!process.env.GDRIVE_SA_KEY,
        GDRIVE_CACHE_FOLDER_ID: !!process.env.GDRIVE_CACHE_FOLDER_ID
      },
      back
    });
  } catch (e) {
    return respond(500, { ok: false, error: e.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body, null, 2)
  };
}
