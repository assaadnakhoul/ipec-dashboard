// scripts/build-agg.js
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import fs from 'node:fs/promises';
import path from 'node:path';

const saEmail   = process.env.GDRIVE_SA_EMAIL;
const saKeyJson = process.env.GDRIVE_SA_KEY;
const folderA   = process.env.FOLDER_INV_A;
const folderB   = process.env.FOLDER_INV_B;
const SCOPES    = ['https://www.googleapis.com/auth/drive.readonly'];

const SUPPLIERS_XLSX = path.join(process.cwd(), 'data', 'suppliers-codes.xlsx'); // IMPORTANT

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

// A) INV-XXX-YYYY (client B3, phone B5, total B8; items A/C/D/E from row 12)
function parseA(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;
  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B5') || '').toString().trim() || null;
  const invoiceTotal = Number(get('B8') || 0);
  const items = [];
  for (let r=12;r<10000;r++){
    const code = get(`A${r}`); if(!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty*unit));
    items.push({ code:String(code).trim(), qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}

// B) IPEC Invoice XXX-YYYY (client B3, phone B4; find 'SUB-TOTAL USD' in D; total in E; items from row 9)
function parseB(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const get = a => ws[a]?.v;
  const client = (get('B3') || '').toString().trim() || null;
  const phone  = (get('B4') || '').toString().trim() || null;
  let invoiceTotal = 0;
  for(let r=11;r<10000;r++){
    const label = (get(`D${r}`) || '').toString().toUpperCase();
    if(label.includes('SUB-TOTAL USD')){ invoiceTotal = Number(get(`E${r}`) || 0); break; }
  }
  const items = [];
  for (let r=9;r<10000;r++){
    const code = get(`A${r}`); if(!code) break;
    const qty   = Number(get(`C${r}`) || 0);
    const unit  = Number(get(`D${r}`) || 0);
    const total = Number(get(`E${r}`) || (qty*unit));
    items.push({ code:String(code).trim(), qty, unit, total });
  }
  return { client, phone, invoiceTotal, items };
}

// read supplier prefix rules (A=prefix, B=supplier, D=category)
function loadRules(buf){
  const wb = XLSX.read(buf, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rules = [];
  for(let r=range.s.r+1; r<=range.e.r; r++){
    const prefix   = (ws[XLSX.utils.encode_cell({c:0,r})]?.v || '').toString().trim();
    if(!prefix) continue;
    const supplier = (ws[XLSX.utils.encode_cell({c:1,r})]?.v || '').toString().trim();
    const category = (ws[XLSX.utils.encode_cell({c:3,r})]?.v || '').toString().trim();
    rules.push({ prefix, supplier: supplier || 'Unknown', category: category || 'Uncategorized' });
  }
  // longest prefix first
  return rules.sort((a,b)=>b.prefix.length - a.prefix.length);
}

function lookup(code, rules){
  for(const r of rules) if(code.startsWith(r.prefix)) return r;
  return { supplier:'Unknown', category:'Uncategorized' };
}

function aggregate(invoices, rules){
  let totalSales = 0;
  const perItem = new Map();       // code -> {code, qty, sales}
  const perSupplier = new Map();   // supplier -> sales
  const perCat = new Map();        // cat -> Map(code->qty)
  const perClient = new Map();     // key(phone||name) -> {name, phone, sales}

  const addItem = (code, qty, sales) => {
    if(!perItem.has(code)) perItem.set(code, { code, qty:0, sales:0 });
    const x = perItem.get(code); x.qty += qty; x.sales += sales;
  };

  for(const inv of invoices){
    totalSales += inv.invoiceTotal || 0;

    const k = (inv.phone||'').trim() || (inv.client||'').trim();
    if(k){
      const c = perClient.get(k) || { name: inv.client||'(No name)', phone: inv.phone||'(No phone)', sales: 0 };
      c.sales += inv.invoiceTotal||0; perClient.set(k, c);
    }

    for(const it of inv.items){
      const rule = lookup(it.code, rules);
      addItem(it.code, it.qty, it.total);

      perSupplier.set(rule.supplier, (perSupplier.get(rule.supplier)||0) + it.total);

      if(!perCat.has(rule.category)) perCat.set(rule.category, new Map());
      const m = perCat.get(rule.category);
      m.set(it.code, (m.get(it.code)||0) + it.qty);
    }
  }

  const topItemsOverall = [...perItem.values()].sort((a,b)=>b.sales-a.sales).slice(0,20);
  const topSuppliers = [...perSupplier.entries()].map(([supplier, sales])=>({supplier, sales}))
    .sort((a,b)=>b.sales-a.sales).slice(0,20);
  const topClients = [...perClient.values()].sort((a,b)=>b.sales-a.sales).slice(0,5);
  const topByCategory = {};
  for(const [cat, m] of perCat.entries()){
    topByCategory[cat] = [...m.entries()].map(([code, qty])=>({code, qty}))
      .sort((a,b)=>b.qty-a.qty).slice(0,10);
  }

  return { totalSales, topItemsOverall, topSuppliers, topClients, topByCategory };
}

async function main(){
  console.log('🔧 Building agg.json …');

  // 1) supplier rules from repo
  const supBuf = await fs.readFile(SUPPLIERS_XLSX);
  const rules = loadRules(supBuf);

  // 2) list & download drive files
  const auth = authClient();
  const drive = google.drive({ version:'v3', auth });
  const [filesA, filesB] = await Promise.all([
    listFolderFiles(drive, folderA),
    listFolderFiles(drive, folderB),
  ]);
  const invA = filesA.filter(f => /^INV-\d{3,}-\d{4,}$/.test(f.name));
  const invB = filesB.filter(f => /^IPEC Invoice \d{3,}-\d{4,}/.test(f.name));

  const parse = async (f, kind) => {
    const wb = XLSX.read(await downloadFile(drive, f.id), { type:'buffer' });
    return kind==='A' ? parseA(wb) : parseB(wb);
  };
  const parsedA = await Promise.all(invA.map(f=>parse(f,'A')));
  const parsedB = await Promise.all(invB.map(f=>parse(f,'B')));
  const all = [...parsedA, ...parsedB];

  // 3) aggregate
  const agg = aggregate(all, rules);
  const outDir = path.join(process.cwd(), 'public');
  await fs.mkdir(outDir, { recursive:true });
  const outFile = path.join(outDir, 'agg.json');
  await fs.writeFile(outFile, JSON.stringify({ generatedAt: Date.now(), ...agg }));
  console.log('✅ Wrote', outFile);
}

main().catch(e=>{ console.error('❌ build-agg failed:', e); process.exit(1); });
