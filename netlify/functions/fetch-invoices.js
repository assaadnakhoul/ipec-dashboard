// netlify/functions/fetch-invoices.js
// Reads invoices from two Google Drive folders, parses Excel, aggregates.
// Supplier is chosen by PREFIX rules from /data/suppliers-codes.xlsx (A=prefix, B=supplier, optional D=category).
// Adds Top Clients (phone first; if no phone, use name). No Netlify Blobs (no caching).

import { google } from 'googleapis';
import * as XLSX from 'xlsx';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// --- Config from environment variables (set these in Netlify UI) ---
const saEmail  = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY;   // paste full JSON key as one line
const folderA  = process.env.FOLDER_INV_A;     // INV-XXX-YYYY
const folderB  = process.env.FOLDER_INV_B;     // IPEC Invoice XXX-YYYY

// Process only the most recent N files from each folder (tune in Netlify env if you want)
const MAX_FILES = parseInt(process.env.MAX_FILES || '40', 10);

// ------------------------------------------------------------------

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

// ---------- Parsers ----------

// Folder A (INV-XXX-YYYY)
// B3 = client name, B5 = phone, B8 = invoice total
// Items start row 12: A=code, C=qty, D=unit, E=total
function parseA_Format(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (a) => ws[a]?.v;

  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B5') || '').toString().trim() || null;
  const invoiceTotal = Number(get('B8') || 0);

  const items = [];
  for (let r = 12; r < 10000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty * unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }
  return { invoiceTotal, client, phone, items };
}

// Folder B (IPEC Invoice XXX-YYYY)
// B3 = client, B4 = phone
// Find "SUB-TOTAL USD" in column D (> row 10), take total from same row column E
// Items start row 9: A=code, C=qty, D=unit, E=total
function parseB_Format(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (a) => ws[a]?.v;

  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B4') || '').toString().trim() || null;

  let invoiceTotal = 0;
  for (let r = 11; r < 10000; r++) {
    const label = String(get(`D${r}`) || '').toUpperCase();
    if (label.includes('SUB-TOTAL USD')) {
      invoiceTotal = Number(get(`E${r}`) || 0);
      break;
    }
  }

  const items = [];
  for (let r = 9; r < 10000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty * unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }
  return { invoiceTotal, client, phone, items };
}

// ---------- Suppliers / categories from PREFIX rules ----------
function loadSupplierPrefixes(xlsxBuffer) {
  // Col A = code prefix, Col B = supplier, Col D (optional) = category
  const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const prefix   = (ws[XLSX.utils.encode_cell({ c: 0, r })]?.v || '').toString().trim();
    if (!prefix) continue;
    const supplier = (ws[XLSX.utils.encode_cell({ c: 1, r })]?.v || '').toString().trim();
    const category = (ws[XLSX.utils.encode_cell({ c: 3, r })]?.v || '').toString().trim();
    rows.push({ prefix, supplier, category: category || null });
  }

  // Longer prefixes win (e.g., TKSA beats TK)
  rows.sort((a, b) => b.prefix.length - a.prefix.length);
  return rows;
}

function pickSupplierAndCategory(code, rules) {
  for (const r of rules) {
    if (code.startsWith(r.prefix)) {
      return { supplier: r.supplier || 'Unknown', category: r.category || 'Uncategorized' };
    }
  }
  return { supplier: 'Unknown', category: 'Uncategorized' };
}

// ---------- Aggregation ----------
function aggregate(invoices, rules) {
  let totalSales = 0;

  const perItem     = new Map(); // code -> { code, qty, sales }
  const perCat      = new Map(); // category -> Map(code -> qty)
  const perSupplier = new Map(); // supplier -> sales
  const perClient   = new Map(); // key -> { name, phone, sales }

  const pushItem = (code, qty, sales) => {
    if (!perItem.has(code)) perItem.set(code, { code, qty: 0, sales: 0 });
    const rec = perItem.get(code);
    rec.qty += qty;
    rec.sales += sales;
  };

  for (const inv of invoices) {
    totalSales += inv.invoiceTotal || 0;

    // Clients: prefer phone, fallback to name
    const phoneKey = (inv.phone || '').trim();
    const nameKey  = (inv.client || '').trim();
    const key = phoneKey || nameKey || null;
    if (key) {
      const current = perClient.get(key) || { name: nameKey || '(No name)', phone: phoneKey || '(No phone)', sales: 0 };
      current.sales += inv.invoiceTotal || 0;
      current.name  = nameKey  || current.name  || '(No name)';
      current.phone = phoneKey || current.phone || '(No phone)';
      perClient.set(key, current);
    }

    for (const it of inv.items) {
      const { supplier, category } = pickSupplierAndCategory(it.code, rules);

      // Overall top items (by sales)
      pushItem(it.code, it.qty, it.total);

      // Top per category (by units)
      if (!perCat.has(category)) perCat.set(category, new Map());
      const cm = perCat.get(category);
      cm.set(it.code, (cm.get(it.code) || 0) + it.qty);

      // Top suppliers (by sales)
      perSupplier.set(supplier, (perSupplier.get(supplier) || 0) + it.total);
    }
  }

  const topItemsOverall = [...perItem.values()]
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 20);

  const topByCategory = {};
  for (const [cat, m] of perCat.entries()) {
    const arr = [...m.entries()].map(([code, qty]) => ({ code, qty }));
    topByCategory[cat] = arr.sort((a, b) => b.qty - a.qty).slice(0, 10);
  }

  const topSuppliers = [...perSupplier.entries()]
    .map(([supplier, sales]) => ({ supplier, sales }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 20);

  const topClients = [...perClient.values()]
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 5);

  return { totalSales, topItemsOverall, topByCategory, topSuppliers, topClients };
}

// ---------- Handler ----------
export const handler = async () => {
  try {
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

    // newest first
    invA.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
    invB.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

    // take only the most recent N from each folder
    const useA = invA.slice(0, MAX_FILES);
    const useB = invB.slice(0, MAX_FILES);

    // Load supplier prefix rules
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const suppliersPath = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');
    const supBuf = await fs.readFile(suppliersPath);
    const rules = loadSupplierPrefixes(supBuf);

    // Parse invoices
    const parseBuffers = async (file, kind) => {
      const buf = await downloadFile(drive, file.id);
      const wb = XLSX.read(buf, { type: 'buffer' });
      return kind === 'A' ? parseA_Format(wb) : parseB_Format(wb);
    };
    const parsedA = await Promise.all(useA.map(f => parseBuffers(f, 'A')));
    const parsedB = await Promise.all(useB.map(f => parseBuffers(f, 'B')));
    const allInv = [...parsedA, ...parsedB];

    const agg = aggregate(allInv, rules);
    const payload = { generatedAt: Date.now(), ...agg };

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
