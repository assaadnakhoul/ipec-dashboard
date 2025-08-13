// scripts/build-agg.js
// Build-time script: fetches ALL invoices from two Drive folders,
// parses them, aggregates, and writes public/agg.json for the dashboard.

import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---- ENV VARS (must be set in Netlify) ----
const saEmail   = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY;   // paste the whole SA JSON as one line
const folderA   = process.env.FOLDER_INV_A;    // INV-XXX-YYYY folder id
const folderB   = process.env.FOLDER_INV_B;    // IPEC Invoice XXX-YYYY folder id

// Your supplier file name & path (you said it's "suppliers-codes"):
const SUPPLIERS_XLSX = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

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
// B3 = client, B5 = phone, B8 = invoice total
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
// Find "SUB-TOTAL USD" in col D (> row 10), total in same row col E
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

// ---------- Supplier prefix rules ----------
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
  rows.sort((a, b) => b.prefix.length - a.prefix.length); // longer matches win
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
  const perCat      = new Map(); // cat -> Map(code -> qty)
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

    // client identity: prefer phone, fallback to name
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

      // overall items by sales
      pushItem(it.code, it.qty, it.total);

      // per category by units
      if (!perCat.has(category)) perCat.set(category, new Map());
      const cm = perCat.get(category);
      cm.set(it.code, (cm.get(it.code) || 0) + it.qty);

      // per supplier by sales
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

// ---------- Main ----------
async function main() {
  if (!saKeyJson || !folderA || !folderB) {
    throw new Error('Missing env vars GDRIVE_SA_KEY / FOLDER_INV_A / FOLDER_INV_B');
  }

  const auth = authClient();
  const drive = google.drive({ version: 'v3', auth });

  // Load supplier prefixes (from repo)
  const supBuf = await fs.readFile(SUPPLIERS_XLSX);
  const rules = loadSupplierPrefixes(supBuf);

  // List ALL files in both folders
  const [filesA, filesB] = await Promise.all([
    listFolderFiles(drive, folderA),
    listFolderFiles(drive, folderB),
  ]);

  // Filter by patterns
  const invA = filesA.filter(f => /^INV-\d{3,}-\d{4,}$/.test(f.name));
  const invB = filesB.filter(f => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name));

  // Sort newest first (not required, but nice)
  invA.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  invB.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

  // Download & parse ALL
  const parseBuffers = async (file, kind) => {
    const buf = await downloadFile(drive, file.id);
    const wb = XLSX.read(buf, { type: 'buffer' });
    return kind === 'A' ? parseA_Format(wb) : parseB_Format(wb);
  };

  const parsedA = await Promise.all(invA.map(f => parseBuffers(f, 'A')));
  const parsedB = await Promise.all(invB.map(f => parseBuffers(f, 'B')));
  const allInv = [...parsedA, ...parsedB];

  const agg = aggregate(allInv, rules);
  const payload = { generatedAt: Date.now(), ...agg };

  // Ensure public/ exists, then write the JSON the dashboard will load
  const outDir = path.join(process.cwd(), 'public');
  try { await fs.mkdir(outDir, { recursive: true }); } catch {}
  const outFile = path.join(outDir, 'agg.json');
  await fs.writeFile(outFile, JSON.stringify(payload));
  console.log(`✅ Wrote ${outFile}`);
}

main().catch(err => {
  console.error('❌ build-agg failed:', err);
  process.exit(1);
});
