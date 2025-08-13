// netlify/functions/fetch-invoices.js
// Reads invoices from two Google Drive folders, parses Excel, aggregates results.
// No caching (so we don't need Netlify Blobs).

import { google } from 'googleapis';
import * as XLSX from 'xlsx';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const saEmail = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY; // full JSON as a string (from Netlify env var)
const folderA = process.env.FOLDER_INV_A;    // INV-XXX-YYYY
const folderB = process.env.FOLDER_INV_B;    // IPEC Invoice XXX-YYYY

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

function parseA_Format(workbook) {
  // A-format (name starts "INV-XXX-YYYY")
  // B8 = invoice total. Items start row 12: A=code, C=qty, D=unit, E=total
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (a) => ws[a]?.v;

  const invoiceTotal = Number(get('B8') || 0);
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
  // B-format (name starts "IPEC Invoice XXX-YYYY")
  // Client B3, Phone B4
  // SUB-TOTAL USD in column D, total is same row column E (> row 10)
  // Items start row 9: A=code, C=qty, D=unit, E=total
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (a) => ws[a]?.v;

  const client = get('B3') || null;
  const phone = get('B4') || null;

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
    const qty = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty * unit));
    items.push({ code: String(code).trim(), qty, unit, total });
  }
  return { invoiceTotal, client, phone, items };
}

function loadSuppliersMap(xlsxBuffer) {
  // Column A=item code, Column B=supplier (if you have it), Column D=category
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

function aggregate(allInvoices, suppliersMap) {
  let totalSales = 0;
  const perItem = new Map();     // code -> { qty, sales }
  const perCat = new Map();      // cat  -> Map(code -> qty)
  const perSupplier = new Map(); // supplier -> sales

  const pushItem = (code, qty, sales) => {
    if (!perItem.has(code)) perItem.set(code, { code, qty: 0, sales: 0 });
    const rec = perItem.get(code);
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
      const m = perCat.get(cat);
      m.set(it.code, (m.get(it.code) || 0) + it.qty);

      perSupplier.set(sup, (perSupplier.get(sup) || 0) + it.total);
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

  return { totalSales, topItemsOverall, topByCategory, topSuppliers };
}

export const handler = async () => {
  try {
    const auth = authClient();
    const drive = google.drive({ version: 'v3', auth });

    // List & filter files from both folders
    const [filesA, filesB] = await Promise.all([
      listFolderFiles(drive, folderA),
      listFolderFiles(drive, folderB),
    ]);
    const invA = filesA.filter(f => /^INV-\d{3,}-\d{4,}$/.test(f.name));
    const invB = filesB.filter(f => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name));

    // Load suppliers mapping from repo
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const suppliersPath = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx');
    const supBuf = await fs.readFile(suppliersPath);
    const suppliersMap = loadSuppliersMap(supBuf);

    // Parse invoices
    const parseBuffers = async (file, kind) => {
      const buf = await downloadFile(drive, file.id);
      const wb = XLSX.read(buf, { type: 'buffer' });
      return kind === 'A' ? parseA_Format(wb) : parseB_Format(wb);
    };
    const parsedA = await Promise.all(invA.map(f => parseBuffers(f, 'A')));
    const parsedB = await Promise.all(invB.map(f => parseBuffers(f, 'B')));
    const allInv = [...parsedA, ...parsedB];

    const payload = { cachedAt: Date.now(), ...aggregate(allInv, suppliersMap) };

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
