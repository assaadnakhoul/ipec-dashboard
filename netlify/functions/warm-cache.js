// netlify/functions/warm-cache.js
// Processes invoices in small batches and stores the running aggregation in Netlify Blobs.
// Uses: suppliers prefixes (data/suppliers-codes.xlsx) and categories (data/categories-descriptions.xlsx, col D).
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import { getStore } from '@netlify/blobs';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const BATCH_SIZE = 40; // ~40 files per call (tweak if you need smaller/faster)

const saEmail   = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY;
const folderA   = process.env.FOLDER_INV_A; // INV-XXX-YYYY
const folderB   = process.env.FOLDER_INV_B; // IPEC Invoice XXX-YYYY

function authClient() {
  const creds = JSON.parse(saKeyJson);
  return new google.auth.JWT({
    email: saEmail || creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
}

async function listFolderFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name)',
      pageToken, pageSize: 1000,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function downloadFile(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// -------- Excel helpers (bundled files) --------
import fs from 'node:fs/promises';
import path from 'node:path';
const SUPPLIERS_XLSX   = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');
const CATEGORIES_XLSX  = path.join(process.cwd(), 'data', 'categories-descriptions.xlsx');

function loadSupplierRules(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rules = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const prefix   = (ws[XLSX.utils.encode_cell({c:0,r})]?.v || '').toString().trim();
    if (!prefix) continue;
    const supplier = (ws[XLSX.utils.encode_cell({c:1,r})]?.v || '').toString().trim();
    const cat      = (ws[XLSX.utils.encode_cell({c:3,r})]?.v || '').toString().trim();
    rules.push({ prefix, supplier: supplier || 'Unknown', fallbackCategory: cat || 'Uncategorized' });
  }
  // longer first
  return rules.sort((a,b)=>b.prefix.length - a.prefix.length);
}

function loadCategoriesMap(buf) {
  // Column A = item code, Column D = category name we want.
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const map = new Map();
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const code = (ws[XLSX.utils.encode_cell({c:0,r})]?.v || '').toString().trim();
    if (!code) continue;
    const category = (ws[XLSX.utils.encode_cell({c:3,r})]?.v || '').toString().trim();
    if (category) map.set(code, category);
  }
  return map;
}

function chooseSupplierCategory(code, supplierRules, categoriesMap) {
  // Prefer explicit categories mapping by exact code (column D)
  if (categoriesMap.has(code)) {
    return { supplier: null, category: categoriesMap.get(code) };
  }
  // fallback: supplier prefix rules and optional fallback category
  for (const r of supplierRules) {
    if (code.startsWith(r.prefix)) {
      return { supplier: r.supplier, category: r.fallbackCategory || 'Uncategorized' };
    }
  }
  return { supplier: 'Unknown', category: 'Uncategorized' };
}

// ---------- parsers ----------
function parseA(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;
  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B5') || '').toString().trim() || null;
  const invoiceTotal = Number(get('B8') || 0);
  const items = [];
  for (let r=12; r<10000; r++) {
    const code = get(`A${r}`); if (!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty*unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}
function parseB(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;
  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B4') || '').toString().trim() || null;
  let invoiceTotal = 0;
  for (let r=11; r<10000; r++) {
    const label = (get(`D${r}`) || '').toString().toUpperCase();
    if (label.includes('SUB-TOTAL USD')) { invoiceTotal = Number(get(`E${r}`) || 0); break; }
  }
  const items = [];
  for (let r=9; r<10000; r++) {
    const code = get(`A${r}`); if (!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty*unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}

// ---------- aggregation helpers ----------
function ensure(map, key, init) {
  const cur = map.get(key);
  if (cur) return cur;
  map.set(key, init); return init;
}

function applyInvoice(inv, agg, supplierRules, categoriesMap) {
  agg.totalSales += inv.invoiceTotal || 0;

  const cKey = (inv.phone || '').trim() || (inv.client || '').trim();
  if (cKey) {
    const c = agg.perClient.get(cKey) || { name: inv.client || '(No name)', phone: inv.phone || '(No phone)', sales: 0 };
    c.sales += inv.invoiceTotal || 0; agg.perClient.set(cKey, c);
  }

  for (const it of inv.items) {
    const meta = chooseSupplierCategory(it.code, supplierRules, categoriesMap);
    // per item
    const item = ensure(agg.perItem, it.code, { code: it.code, qty: 0, sales: 0 });
    item.qty += it.qty; item.sales += it.total;

    // per supplier (only if we got supplier from rules)
    const sup = meta.supplier || 'Unknown';
    agg.perSupplier.set(sup, (agg.perSupplier.get(sup) || 0) + it.total);

    // per category
    const cat = meta.category || 'Uncategorized';
    const catMap = ensure(agg.perCat, cat, new Map());
    catMap.set(it.code, (catMap.get(it.code) || 0) + it.qty);
  }
}

function finalizeAgg(agg) {
  const topItemsOverall = [...agg.perItem.values()]
    .sort((a,b)=>b.sales-a.sales).slice(0, 50);
  const topSuppliers = [...agg.perSupplier.entries()]
    .map(([supplier, sales])=>({ supplier, sales }))
    .sort((a,b)=>b.sales-a.sales).slice(0, 50);
  const topClients = [...agg.perClient.values()]
    .sort((a,b)=>b.sales-a.sales).slice(0, 50);
  const topByCategory = {};
  for (const [cat, m] of agg.perCat.entries()) {
    topByCategory[cat] = [...m.entries()].map(([code, qty])=>({ code, qty }))
      .sort((a,b)=>b.qty-a.qty).slice(0, 50);
  }
  return { totalSales: agg.totalSales, topItemsOverall, topSuppliers, topClients, topByCategory };
}

export const handler = async () => {
  try {
    const store = getStore('ipec-dash');
    let progress = await store.get('progress.json', { type: 'json' });

    // init progress (first call)
    if (!progress) {
      const auth = authClient();
      const drive = google.drive({ version: 'v3', auth });
      const [filesA, filesB] = await Promise.all([
        listFolderFiles(drive, folderA),
        listFolderFiles(drive, folderB),
      ]);
      const invA = filesA.filter(f => /^INV-\d{3,}-\d{4,}$/.test(f.name)).map(f=>({ id:f.id, kind:'A' }));
      const invB = filesB.filter(f => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name)).map(f=>({ id:f.id, kind:'B' }));
      const queue = [...invA, ...invB];

      progress = {
        queue,
        index: 0,
        total: queue.length,
        done: false
      };

      // create empty aggregation maps (serialized as arrays of [key,val])
      const emptyAgg = {
        totalSales: 0,
        perItem: [],       // [code, {code,qty,sales}]
        perSupplier: [],   // [name, sales]
        perCat: [],        // [cat, [code,qty]]
        perClient: []      // [key, {name,phone,sales}]
      };
      await store.setJSON('agg-work.json', emptyAgg);
      await store.setJSON('progress.json', progress);
    }

    // load working agg
    const work = await store.get('agg-work.json', { type: 'json' });
    const agg = {
      totalSales: work.totalSales || 0,
      perItem: new Map(work.perItem || []),
      perSupplier: new Map(work.perSupplier || []),
      perCat: new Map((work.perCat || []).map(([cat, arr]) => [cat, new Map(arr)])),
      perClient: new Map(work.perClient || [])
    };

    // load Excel helpers (from repo)
    const [supBuf, catBuf] = await Promise.all([
      fs.readFile(SUPPLIERS_XLSX),
      fs.readFile(CATEGORIES_XLSX)
    ]);
    const supplierRules = loadSupplierRules(supBuf);
    const categoriesMap = loadCategoriesMap(catBuf);

    // auth for this batch
    const drive = google.drive({ version: 'v3', auth: authClient() });

    const start = progress.index;
    const end = Math.min(progress.index + BATCH_SIZE, progress.total);
    let processed = 0;

    for (let i=start; i<end; i++) {
      const { id, kind } = progress.queue[i];
      const buf = await downloadFile(drive, id);
      const wb = XLSX.read(buf, { type:'buffer' });
      const inv = (kind === 'A') ? parseA(wb) : parseB(wb);
      applyInvoice(inv, agg, supplierRules, categoriesMap);
      processed++;
    }

    progress.index = end;
    progress.done = progress.index >= progress.total;

    // save running agg back to blobs (serialize maps)
    const toStore = {
      totalSales: agg.totalSales,
      perItem: [...agg.perItem.entries()],
      perSupplier: [...agg.perSupplier.entries()],
      perCat: [...[...agg.perCat.entries()].map(([cat, m]) => [cat, [...m.entries()]])],
      perClient: [...agg.perClient.entries()]
    };
    await store.setJSON('agg-work.json', toStore);
    await store.setJSON('progress.json', progress);

    // if finished, compute top arrays and store final agg
    if (progress.done) {
      const final = finalizeAgg(agg);
      await store.setJSON('agg.json', { generatedAt: Date.now(), ...final });
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        processed,
        index: progress.index,
        total: progress.total,
        remaining: progress.total - progress.index,
        done: progress.done
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
