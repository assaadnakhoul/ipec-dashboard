import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const saEmail = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY;
const folderA = process.env.FOLDER_INV_A;
const folderB = process.env.FOLDER_INV_B;

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

function parseINV(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const client = get('B3') || null;
  const phone = get('B5') || null;
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
  return { client, phone, invoiceTotal, items };
}

function parseIPEC(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const get = (addr) => ws[addr]?.v;

  const client = get('B3') || null;
  const phone = get('B4') || null;
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
  return { client, phone, invoiceTotal, items };
}

function aggregate(allInvoices, suppliersMap) {
  let totalSales = 0;
  const perItem = new Map();
  const perSupplier = new Map();
  const perClient = new Map();

  const pushItem = (code, qty, sales) => {
    if (!perItem.has(code)) perItem.set(code, { code, qty: 0, sales: 0 });
    const rec = perItem.get(code);
    rec.qty += qty;
    rec.sales += sales;
  };

  for (const inv of allInvoices) {
    totalSales += inv.invoiceTotal || 0;

    // Clients
    const cKey = inv.phone || inv.client || 'Unknown';
    if (!perClient.has(cKey)) perClient.set(cKey, { name: inv.client, phone: inv.phone, sales: 0 });
    perClient.get(cKey).sales += inv.invoiceTotal || 0;

    for (const it of inv.items) {
      const meta = suppliersMap.get(it.code) || {};
      const sup = meta.supplier || 'Unknown';
      pushItem(it.code, it.qty, it.total);

      if (!perSupplier.has(sup)) perSupplier.set(sup, 0);
      perSupplier.set(sup, perSupplier.get(sup) + it.total);
    }
  }

  const topItemsOverall = [...perItem.values()].sort((a, b) => b.sales - a.sales).slice(0, 20);
  const topSuppliers = [...perSupplier.entries()].map(([supplier, sales]) => ({ supplier, sales }))
    .sort((a, b) => b.sales - a.sales).slice(0, 20);
  const topClients = [...perClient.values()].sort((a, b) => b.sales - a.sales).slice(0, 5);

  return { totalSales, topItemsOverall, topSuppliers, topClients };
}

function loadSuppliersMap(xlsxBuffer) {
  const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const map = new Map();

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const prefix = (ws[XLSX.utils.encode_cell({ c: 0, r })]?.v || '').toString().trim();
    const supplier = (ws[XLSX.utils.encode_cell({ c: 1, r })]?.v || '').toString().trim();
    if (prefix) map.set(prefix, { supplier });
  }
  return map;
}

async function main() {
  const auth = authClient();
  const drive = google.drive({ version: 'v3', auth });

  const [filesA, filesB] = await Promise.all([
    listFolderFiles(drive, folderA),
    listFolderFiles(drive, folderB),
  ]);

  const suppliersPath = path.join(process.cwd(), 'suppliers-codes.xlsx');
  const supBuf = fs.readFileSync(suppliersPath);
  const suppliersMap = loadSuppliersMap(supBuf);

  const parsedA = await Promise.all(filesA.map(async f => parseINV(XLSX.read(await downloadFile(drive, f.id), { type: 'buffe
