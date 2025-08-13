// netlify/functions/warm-cache.js
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import * as XLSX from 'xlsx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { store, readJSON, AGG_KEY, STATE_KEY } from './_lib/store.js';

// ---------- config ----------
const FILES_PER_CHUNK = 25; // files processed per invocation

// ---------- helpers: auth + drive ----------
function makeAuth() {
  const saEmail  = process.env.GDRIVE_SA_EMAIL;
  const saKeyStr = process.env.GDRIVE_SA_KEY;
  if (!saEmail || !saKeyStr) throw new Error('Missing GDRIVE_SA_EMAIL or GDRIVE_SA_KEY');

  const creds = JSON.parse(saKeyStr);
  return new JWT({
    email: saEmail || creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

function driveClient(auth) {
  return google.drive({ version: 'v3', auth });
}

async function listFolderFiles(drive, folderId) {
  const out = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 1000,
      pageToken,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return out;
}

async function downloadFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ---------- helpers: local xlsx maps ----------
async function loadSuppliersMap() {
  const p = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');
  const buf = await fs.readFile(p);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const map = []; // {prefix, supplier}
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const a = ws[XLSX.utils.encode_cell({ c: 0, r })]?.v?.toString().trim();
    const b = ws[XLSX.utils.encode_cell({ c: 1, r })]?.v?.toString().trim();
    if (a && b) map.push({ prefix: a, supplier: b });
  }
  map.sort((x, y) => y.prefix.length - x.prefix.length);
  return map;
}

async function loadCategoriesMap() {
  const p = path.join(process.cwd(), 'data', 'categories-descriptions.xlsx');
  const buf = await fs.readFile(p);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const map = new Map(); // code -> category
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const code = ws[XLSX.utils.encode_cell({ c: 0, r })]?.v?.toString().trim();
    const cat  = ws[XLSX.utils.encode_cell({ c: 3, r })]?.v?.toString().trim();
    if (code && cat) map.set(code, cat);
  }
  return map;
}

const resolveSupplier = (arr, code) => (arr.find(x => code.startsWith(x.prefix))?.supplier ?? 'Unknown');
const resolveCategory = (m, code) => m.get(code) ?? 'Uncategorized';

// ---------- parse invoices ----------
function parseA(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B5') || '').toString().trim() || null;
  const invoiceTotal = Number(get('B8') || 0);

  const items = [];
  for (let r = 12; r < 10000; r++) {
    const code = get(`A${r}`)?.toString().trim();
    if (!code) break;
    const qty  = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total= Number(get(`E${r}`) || (qty * unit));
    items.push({ code, qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}

function parseB(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B4') || '').toString().trim() || null;

  let invoiceTotal = 0;
  for (let r = 11; r < 10000; r++) {
    const label = (get(`D${r}`) || '').toString().toUpperCase();
    if (label.includes('SUB-TOTAL USD')) {
      invoiceTotal = Number(get(`E${r}`) || 0);
      break;
    }
  }

  const items = [];
  for (let r = 9; r < 10000; r++) {
    const code = get(`A${r}`)?.toString().trim();
    if (!code) break;
    const qty  = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total= Number(get(`E${r}`) || (qty * unit));
    items.push({ code, qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}

// ---------- aggregation ----------
function mergeAgg(target, add) {
  target.totalSales = (target.totalSales || 0) + (add.totalSales || 0);

  if (!target.perSupplier) target.perSupplier = {};
  for (const [s, v] of Object.entries(add.perSupplier || {})) {
    target.perSupplier[s] = (target.perSupplier[s] || 0) + v;
  }

  if (!target.perItem) target.perItem = {};
  for (const [code, obj] of Object.entries(add.perItem || {})) {
    const t = target.perItem[code] || { qty: 0, sales: 0 };
    t.qty += obj.qty || 0;
    t.sales += obj.sales || 0;
    target.perItem[code] = t;
  }

  if (!target.perCat) target.perCat = {};
  for (const [cat, codes] of Object.entries(add.perCat || {})) {
    if (!target.perCat[cat]) target.perCat[cat] = {};
    for (const [code, qty] of Object.entries(codes)) {
      target.perCat[cat][code] = (target.perCat[cat][code] || 0) + qty;
    }
  }

  if (!target.perClient) target.perClient = {};
  for (const [k, v] of Object.entries(add.perClient || {})) {
    target.perClient[k] = (target.perClient[k] || 0) + v;
  }
}

function aggregateInvoices(invoices, supPrefixes, catMap) {
  const agg = { totalSales: 0, perSupplier: {}, perItem: {}, perCat: {}, perClient: {} };
  const ensure = (obj, key, def) => (obj[key] ??= def);

  for (const inv of invoices) {
    agg.totalSales += inv.invoiceTotal || 0;

    const clientKey = (inv.phone && inv.phone.toString().trim()) || (inv.client && inv.client.trim()) || 'Unknown';
    agg.perClient[clientKey] = (agg.perClient[clientKey] || 0) + (inv.invoiceTotal || 0);

    for (const it of inv.items) {
      const code = it.code;
      const supplier = resolveSupplier(supPrefixes, code);
      const cat = resolveCategory(catMap, code);

      agg.perSupplier[supplier] = (agg.perSupplier[supplier] || 0) + (it.total || 0);

      const p = ensure(agg.perItem, code, { qty: 0, sales: 0 });
      p.qty   += it.qty   || 0;
      p.sales += it.total || 0;

      const catCodes = ensure(agg.perCat, cat, {});
      catCodes[code] = (catCodes[code] || 0) + (it.qty || 0);
    }
  }
  return agg;
}

// ---------- main handler ----------
export const handler = async () => {
  try {
    // Ensure store is reachable
    await store();

    const auth  = makeAuth();
    const drive = driveClient(auth);

    let state = (await readJSON(STATE_KEY)) || {
      startedAt: Date.now(),
      folderA: process.env.FOLDER_INV_A,
      folderB: process.env.FOLDER_INV_B,
      files: null,        // [{id,name,kind:'A'|'B'}]
      chunkIndex: 0,
      done: false,
      chunks: 0,
    };

    // First run: list files
    if (!state.files) {
      const [fa, fb] = await Promise.all([
        listFolderFiles(drive, state.folderA),
        listFolderFiles(drive, state.folderB),
      ]);

      const taggedA = (fa || [])
        .filter((f) => /^INV-\d{3,}-\d{4,}/.test(f.name))
        .map((f) => ({ ...f, kind: 'A' }));

      const taggedB = (fb || [])
        .filter((f) => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name))
        .map((f) => ({ ...f, kind: 'B' }));

      const all = [...taggedA, ...taggedB].sort(
        (x, y) => new Date(y.modifiedTime) - new Date(x.modifiedTime)
      );

      state.files = all;
      state.chunks = Math.ceil(all.length / FILES_PER_CHUNK);
      state.chunkIndex = 0;
      state.done = false;
      await writeJSON(STATE_KEY, state);
    }

    // Already finished?
    if (state.done) {
      return json({ ok: true, done: true, files: state.files.length });
    }

    // Load helper maps once
    const [supPrefixes, catMap] = await Promise.all([
      loadSuppliersMap(),
      loadCategoriesMap(),
    ]);

    // Work on one chunk
    const start = state.chunkIndex * FILES_PER_CHUNK;
    const end   = Math.min(start + FILES_PER_CHUNK, state.files.length);
    const slice = state.files.slice(start, end);

    const partialInvoices = [];
    for (const f of slice) {
      try {
        const buf = await downloadFile(drive, f.id);
        const wb  = XLSX.read(buf, { type: 'buffer' });
        const inv = f.kind === 'A' ? parseA(wb) : parseB(wb);
        partialInvoices.push(inv);
      } catch {
        // skip unreadable file
      }
    }

    const partialAgg = aggregateInvoices(partialInvoices, supPrefixes, catMap);
    const chunkKey = `${CHUNK_PREFIX}${state.chunkIndex}.json`;
    await writeJSON(chunkKey, partialAgg);

    // Advance
    state.chunkIndex += 1;
    await writeJSON(STATE_KEY, state);

    // Last chunk? Merge all
    if (state.chunkIndex >= state.chunks) {
      const final = {};
      for (let i = 0; i < state.chunks; i++) {
        const part = await readJSON(`${CHUNK_PREFIX}${i}.json`, null);
        if (part) mergeAgg(final, part);
      }

      const topItemsOverall = Object.entries(final.perItem || {})
        .map(([code, { qty, sales }]) => ({ code, qty, sales }))
        .sort((a, b) => b.qty - a.qty);

      const topByCategory = {};
      for (const [cat, obj] of Object.entries(final.perCat || {})) {
        topByCategory[cat] = Object.entries(obj)
          .map(([code, qty]) => ({ code, qty }))
          .sort((a, b) => b.qty - a.qty);
      }

      const topSuppliers = Object.entries(final.perSupplier || {})
        .map(([supplier, sales]) => ({ supplier, sales }))
        .sort((a, b) => b.sales - a.sales);

      const topClients = Object.entries(final.perClient || {})
        .map(([client, sales]) => ({ client, sales }))
        .sort((a, b) => b.sales - a.sales);

      const payload = {
        cachedAt: Date.now(),
        totalSales: final.totalSales || 0,
        topItemsOverall,
        topByCategory,
        topSuppliers,
        topClients,
        meta: { files: state.files.length, chunks: state.chunks },
      };

      await writeJSON(AGG_KEY, payload);
      state.done = true;
      await writeJSON(STATE_KEY, state);

      return json({ ok: true, done: true, built: true, files: state.files.length });
    }

    // Not done yet
    return json({
      ok: true,
      done: false,
      processed: end,
      remaining: state.files.length - end,
      chunk: state.chunkIndex,
      chunks: state.chunks,
    });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
};

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}
