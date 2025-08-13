// netlify/functions/fetch-invoices.js
// Aggregates invoices from two Google Drive folders, parses Excel, returns fast JSON.
// Caches results in Netlify Blobs for quick loads.

import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import { getStore } from '@netlify/blobs';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const saEmail = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY; // entire SA key JSON content as a string
const folderA = process.env.FOLDER_INV_A;    // INV-XXX-YYYY
const folderB = process.env.FOLDER_INV_B;    // IPEC Invoice XXX-YYYY
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '900', 10);

function authClient() {
  const creds = JSON.parse(saKeyJson);
  return new google.auth.JWT({
    email: saEmail || creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
}

async function listFolderFiles(drive, folderId) {
  // Handles pagination
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageToken,
      pageSize: 1000,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function downloadFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

function parseA_Format(workbook) {
  // “INV-XXX-YYYY”
  // B8 = invoice total
  // Items start row 12: A=code, C=qty, D=unit price, E=line total. Stop when column A is empty.
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const invoiceTotal = get('B8') || 0;

  // Scan items from row 12 downward
  const items = [];
  for (let r = 12; r < 10000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty * unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }

  return { invoiceTotal, client: null, phone: null, items };
}

function parseB_Format(workbook) {
  // “IPEC Invoice XXX-YYYY”
  // SUB-TOTAL USD in column D, total is in E on same row (after row 10)
  // Client: B3, Phone: B4
  // Items start row 9: A=code, C=qty, D=unit, E=total. Stop when column A empty.
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const client = get('B3') || null;
  const phone = get('B4') || null;

  // Find SUB-TOTAL USD row (col D)
  let invoiceTotal = 0;
  for (let r = 11; r < 10000; r++) {
    const label = get(`D${r}`);
    if (String(label || '').toUpperCase().includes('SUB-TOTAL USD')) {
      invoiceTotal = Number(get(`E${r}`) || 0);
      break;
    }
  }

  const items = [];
  for (let r = 9; r < 10000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty * unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }

  return { invoiceTotal, client, phone, items };
}

function aggregate(allInvoices, suppliersMap) {
  let totalSales = 0;

  const perItem = new Map();     // code -> { qty, sales }
  const perCat = new Map();      // category -> { code -> qty }
  const perSupplier = new Map(); // supplier -> sales

  const pushItem = (code, qty, sales) => {
    const key = code;
    if (!perItem.has(key)) perItem.set(key, { code, qty: 0, sales: 0 });
    const rec = perItem.get(key);
    rec.qty += qty;
    rec.sales += sales;
  };

  for (const inv of allInvoices) {
    totalSales += inv.invoiceTotal || 0;
    for (const it of inv.items) {
      const meta = suppliersMap.get(it.code) || {};
      const cat = meta.category || 'Uncategorized';
      const sup = meta.supplier || 'Unknown';

      pushItem(it.code, it.qty, it.total);

      if (!perCat.has(cat)) perCat.set(cat, new Map());
      const catMap = perCat.get(cat);
      if (!catMap.has(it.code)) catMap.set(it.code, 0);
      catMap.set(it.code, catMap.get(it.code) + it.qty);

      if (!perSupplier.has(sup)) perSupplier.set(sup, 0);
      perSupplier.set(sup, perSupplier.get(sup) + it.total);
    }
  }

  // Top items overall (by sales)
  const topItemsOverall = [...perItem.values()]
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 20);

  // Top 10 unit sales for each category
  const topByCategory = {};
  for (const [cat, map] of perCat.entries()) {
    const arr = [...map.entries()].map(([code, qty]) => ({ code, qty }));
    topByCategory[cat] = arr.sort((a, b) => b.qty - a.qty).slice(0, 10);
  }

  // Top suppliers by sales
  const topSuppliers = [...perSupplier.entries()]
    .map(([supplier, sales]) => ({ supplier, sales }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 20);

  return { totalSales, topItemsOverall, topByCategory, topSuppliers };
}

function loadSuppliersMap(xlsxBuffer) {
  // Expect: Column A=item code, Column D=category, optionally Column B=supplier (if available)
  const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const map = new Map();

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const code = (ws[XLSX.utils.encode_cell({ c: 0, r })]?.v || '').toString().trim();
    if (!code) continue;
    const supplier = (ws[XLSX.utils.encode_cell({ c: 1, r })]?.v || '').toString().trim();
    const category = (ws[XLSX.utils.encode_cell({ c: 3, r })]?.v || '').toString().trim();
    map.set(code, { supplier, category });
  }
  return map;
}

export const handler = async (event) => {
  try {
    const store = getStore('ipec-dashboard-cache');
    const cached = await store.get('agg.json', { type: 'json' });
    const now = Date.now();

    if (cached && cached.cachedAt && (now - cached.cachedAt) / 1000 < CACHE_TTL_SECONDS) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify(cached),
      };
    }

    // Auth & drive clients
    const auth = authClient();
    const drive = google.drive({ version: 'v3', auth });

    // List files in each folder
    const [filesA, filesB] = await Promise.all([
      listFolderFiles(drive, folderA),
      listFolderFiles(drive, folderB),
    ]);

    // Filter by naming patterns
    const invA = filesA.filter(f => /^INV-\d{3,}-\d{4,}$/.test(f.name));
    const invB = filesB.filter(f => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name));

    // Download suppliers-codes.xlsx from /data/ (bundled in repo at build time)
    // In Netlify Functions, use relative path via process.cwd()
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const suppliersPath = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');
    const supBuf = await fs.readFile(suppliersPath);
    const suppliersMap = loadSuppliersMap(supBuf);

    // Download & parse invoices
    const parseBuffers = async (file, kind) => {
      const buf = await downloadFile(drive, file.id);
      const wb = XLSX.read(buf, { type: 'buffer' });
      return kind === 'A' ? parseA_Format(wb) : parseB_Format(wb);
    };

    const parsedA = await Promise.all(invA.map(f => parseBuffers(f, 'A')));
    const parsedB = await Promise.all(invB.map(f => parseBuffers(f, 'B')));
    const allInv = [...parsedA, ...parsedB];

    const agg = aggregate(allInv, suppliersMap);
    const payload = { cachedAt: now, ...agg };

    await store.setJSON('agg.json', payload);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
