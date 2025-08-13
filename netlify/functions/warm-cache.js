// warm-cache.js — processes a small batch of invoices from Drive, updates Blobs.
// Re-run until {done:true}. Safe to call many times.

import { getStore } from '@netlify/blobs';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const BATCH_FILES = 12; // how many invoices to parse per warm call
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

const SA_EMAIL = process.env.GDRIVE_SA_EMAIL;
const SA_KEY   = process.env.GDRIVE_SA_KEY; // full JSON string or private key
const FOLDER_A = process.env.FOLDER_INV_A;  // INV-XXX-YYYY  (B3=name, B5=phone, B8=total; rows from 12)
const FOLDER_B = process.env.FOLDER_INV_B;  // IPEC Invoice XXX-YYYY (SUB-TOTAL USD in D/E; B3 name, B4 phone; rows from 9)

function auth() {
  // SA_KEY can be either the whole JSON or just the private_key. Try JSON first.
  let client_email = SA_EMAIL;
  let private_key = SA_KEY;
  try {
    const j = JSON.parse(SA_KEY);
    client_email = j.client_email || SA_EMAIL;
    private_key  = j.private_key;
  } catch {}
  return new google.auth.JWT({ email: client_email, key: private_key, scopes: SCOPES });
}

function drive(authClient) {
  return google.drive({ version: 'v3', auth: authClient });
}

async function listFiles(drive, folderId, pageToken=null) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)',
    pageSize: 1000,
    pageToken
  });
  return { files: res.data.files || [], nextPageToken: res.data.nextPageToken || null };
}

async function downloadBuffer(drive, id) {
  const res = await drive.files.get({ fileId:id, alt:'media' }, { responseType:'arraybuffer' });
  return Buffer.from(res.data);
}

function loadLocalXlsx(relative) {
  const p = path.join(process.cwd(), relative);
  return XLSX.read(fs.readFileSync(p));
}

// prefix → supplier; categories by item code → Column D
function buildMaps() {
  // suppliers
  const wbS = loadLocalXlsx('data/suppliers-codes.xlsx');
  const wsS = wbS.Sheets[wbS.SheetNames[0]];
  const rS  = XLSX.utils.decode_range(wsS['!ref']);
  const prefixToSupplier = new Map();
  for (let r = rS.s.r+1; r <= rS.e.r; r++) {
    const codePref = (wsS[XLSX.utils.encode_cell({c:0,r})]?.v || '').toString().trim();
    const supplier = (wsS[XLSX.utils.encode_cell({c:1,r})]?.v || '').toString().trim();
    if (codePref && supplier) prefixToSupplier.set(codePref, supplier);
  }

  // categories
  const wbC = loadLocalXlsx('data/categories-descriptions.xlsx');
  const wsC = wbC.Sheets[wbC.SheetNames[0]];
  const rC  = XLSX.utils.decode_range(wsC['!ref']);
  const codeToCategory = new Map();
  for (let r = rC.s.r+1; r <= rC.e.r; r++) {
    const code = (wsC[XLSX.utils.encode_cell({c:0,r})]?.v || '').toString().trim(); // Column A
    const cat  = (wsC[XLSX.utils.encode_cell({c:3,r})]?.v || '').toString().trim(); // Column D
    if (code) codeToCategory.set(code, cat || 'Uncategorized');
  }
  return { prefixToSupplier, codeToCategory };
}

function supplierFor(code, prefixMap) {
  for (const [pref,supp] of prefixMap.entries()) {
    if (code.startsWith(pref)) return supp;
  }
  return 'Unknown';
}

function catFor(code, codeToCategory) {
  return codeToCategory.get(code) || 'Uncategorized';
}

/* --- parse formats --- */

function parseFormatA(buf) {
  // INV-XXX-YYYY
  const wb = XLSX.read(buf, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;

  const client = (get('B3') || '').toString().trim();
  const phone  = (get('B5') || '').toString().trim();
  const invoiceTotal = Number(get('B8') || 0);

  const items = [];
  for (let r=12; r<2000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty  = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total= Number(get(`E${r}`) || qty*unit);
    items.push({ code:String(code).trim(), qty, unit, total });
  }

  return { invoiceTotal, client, phone, items };
}

function parseFormatB(buf) {
  // IPEC Invoice XXX-YYYY
  const wb = XLSX.read(buf, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;

  const client = (get('B3') || '').toString().trim();
  const phone  = (get('B4') || '').toString().trim();

  let invoiceTotal = 0;
  for (let r = 11; r < 2000; r++) {
    const label = (get(`D${r}`) || '').toString().toUpperCase();
    if (label.includes('SUB-TOTAL USD')) {
      invoiceTotal = Number(get(`E${r}`) || 0);
      break;
    }
  }

  const items = [];
  for (let r=9; r<2000; r++) {
    const code = get(`A${r}`);
    if (!code) break;
    const qty  = Number(get(`C${r}`) || 0);
    const unit = Number(get(`D${r}`) || 0);
    const total= Number(get(`E${r}`) || qty*unit);
    items.push({ code:String(code).trim(), qty, unit, total });
  }

  return { invoiceTotal, client, phone, items };
}

/* --- aggregate into dashboard --- */

function emptyAgg() {
  return {
    totalSales: 0,
    topSuppliers: new Map(),  // supplier → sales
    topItems: new Map(),      // code → {qty, sales}
    topClients: new Map(),    // phone|name → sales
    byCategory: new Map(),    // category → Map(code → qty)
  };
}

function addInvoice(agg, inv, maps) {
  agg.totalSales += inv.invoiceTotal || 0;

  inv.items.forEach(it => {
    const code = it.code;
    const sales = it.total || 0;
    const qty   = it.qty || 0;

    // items overall
    if (!agg.topItems.has(code)) agg.topItems.set(code, { code, qty:0, sales:0 });
    const i = agg.topItems.get(code);
    i.qty += qty; i.sales += sales;

    // supplier
    const supplier = supplierFor(code, maps.prefixToSupplier);
    agg.topSuppliers.set(supplier, (agg.topSuppliers.get(supplier) || 0) + sales);

    // category → qty
    const cat = catFor(code, maps.codeToCategory);
    if (!agg.byCategory.has(cat)) agg.byCategory.set(cat, new Map());
    const m = agg.byCategory.get(cat);
    m.set(code, (m.get(code)||0) + qty);
  });

  // clients
  const key = inv.phone || inv.client || 'Unknown';
  agg.topClients.set(key, (agg.topClients.get(key)||0) + (inv.invoiceTotal || 0));
}

function finalizeAgg(agg) {
  const obj = {
    totalSales: Math.round(agg.totalSales),
    topSuppliers: [...agg.topSuppliers.entries()]
      .map(([supplier, sales]) => ({ supplier, sales:Math.round(sales) }))
      .sort((a,b)=>b.sales-a.sales)
      .slice(0, 20),

    topItemsOverall: [...agg.topItems.values()]
      .sort((a,b)=>b.sales-a.sales)
      .slice(0, 100),

    topClients: [...agg.topClients.entries()]
      .map(([id, sales]) => ({ phone:id.match(/^\+?\d/) ? id : null, name: id.match(/^\+?\d/) ? null : id, sales:Math.round(sales) }))
      .sort((a,b)=>b.sales-a.sales)
      .slice(0, 50),

    topByCategory: {},
  };

  for (const [cat, map] of agg.byCategory.entries()) {
    obj.topByCategory[cat] = [...map.entries()]
      .map(([code, qty]) => ({ code, qty }))
      .sort((a,b)=>b.qty-a.qty)
      .slice(0, 20);
  }
  return obj;
}

export const handler = async () => {
  const store = getStore('ipec-cache');

  // load or init state
  let state = await store.get('state.json', { type:'json' });
  if (!state) {
    state = {
      startedAt: Date.now(),
      done: false,
      cursor: { phase: 'A', tokenA: null, tokenB: null, indexInPage: 0 },
      processed: new Set(), // store as array in blob
      agg: null,
      data: null
    };
  }
  // revive set
  if (Array.isArray(state.processed)) state.processed = new Set(state.processed);
  if (!state.agg) state.agg = emptyAgg();

  const authClient = auth();
  const d = drive(authClient);
  const maps = buildMaps();

  let files = [];
  let nextToken = null;

  const phase = state.cursor.phase; // 'A' or 'B'
  if (phase === 'A') {
    ({ files, nextToken } = await listFiles(d, FOLDER_A, state.cursor.tokenA));
  } else {
    ({ files, nextToken } = await listFiles(d, FOLDER_B, state.cursor.tokenB));
  }

  let processedNow = 0;

  for (let i = state.cursor.indexInPage; i < files.length; i++) {
    const f = files[i];
    if (state.processed.has(f.id)) continue;

    // filter by file name patterns
    const name = f.name || '';
    const isA = /^INV-\d{3,}-\d{4,}$/.test(name);
    const isB = /^IPEC Invoice \d{3,}-\d{4,}/.test(name);
    if ((phase === 'A' && !isA) || (phase === 'B' && !isB)) continue;

    const buf = await downloadBuffer(d, f.id);
    const inv = phase === 'A' ? parseFormatA(buf) : parseFormatB(buf);
    addInvoice(state.agg, inv, maps);

    state.processed.add(f.id);
    processedNow++;
    if (processedNow >= BATCH_FILES) {
      state.cursor.indexInPage = i + 1;
      await persist();
      return done(false, processedNow);
    }
  }

  // page finished
  if (nextToken) {
    if (phase === 'A') state.cursor.tokenA = nextToken;
    else state.cursor.tokenB = nextToken;
    state.cursor.indexInPage = 0;
    await persist();
    return done(false, processedNow);
  }

  // phase finished, move to next or finalize
  if (phase === 'A') {
    state.cursor.phase = 'B';
    state.cursor.indexInPage = 0;
    await persist();
    return done(false, processedNow);
  }

  // All finished → finalize
  state.data = finalizeAgg(state.agg);
  state.done = true;
  await persist();
  return done(true, processedNow);

  async function persist() {
    // sets are not JSON-able
    const save = { ...state, processed:[...state.processed] };
    await store.setJSON('state.json', save);
  }

  function done(isDone, count) {
    return {
      statusCode: 200,
      headers: { 'content-type':'application/json', 'cache-control':'no-store' },
      body: JSON.stringify({ done:isDone, processed:count })
    };
  }
};
