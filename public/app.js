// public/app.js

// ---------- tiny helpers ----------
const $  = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const API_URL = '/.netlify/functions/get-agg';
const POLL_MS = 5000;   // wait 5s between checks while data is building
const MAX_POLLS = 60;   // ~5 minutes max

// Optional status line in your HTML: <div id="status"></div>
function setStatus(msg) {
  const el = $('#status');
  if (el) el.textContent = msg;
  else console.log('[status]', msg);
}

// ---------- charts ----------
let charts = {};
function makeBar(id, labels, values, label) {
  const el = $(id);
  if (!el) return;
  const ctx = el.getContext('2d');
  charts[id] && charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        borderWidth: 0,
        borderRadius: 8
      }]
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#cfd6f8' }, grid: { display: false } },
        y: { ticks: { color: '#8b93a7' }, grid: { color: 'rgba(255,255,255,.05)' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${label}: $${fmt(c.parsed.y)}` } }
      }
    }
  });
}

// ---------- data loading (polls until ready) ----------
async function fetchAggOnce() {
  const res = await fetch(API_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadDataWithPolling() {
  for (let i = 0; i < MAX_POLLS; i++) {
    const json = await fetchAggOnce();
    if (json.ready) return json.data;

    setStatus('Building data from invoices… please wait');
    await sleep(POLL_MS);
  }
  throw new Error('Timed out waiting for aggregation to finish.');
}

// ---------- render helpers ----------
function renderSupplierLogos(suppliers) {
  const wrap = $('#supplierLogos');
  if (!wrap) return;
  wrap.innerHTML = '';
  const tpl = $('#logoTpl');
  suppliers.slice(0, 8).forEach(s => {
    const node = tpl?.content?.firstElementChild?.cloneNode(true) || document.createElement('figure');
    const img = node.querySelector?.('.logo-img') || document.createElement('img');
    const cap = node.querySelector?.('figcaption') || document.createElement('figcaption');
    cap.textContent = s.supplier;
    const nameForFile = s.supplier.replace(/[^\w\-]+/g, '');
    img.src = `/images/logos/${nameForFile}.png`;
    img.alt = s.supplier;
    img.onerror = () => node.style.display = 'none';
    if (!node.contains(img)) node.appendChild(img);
    if (!node.contains(cap)) node.appendChild(cap);
    wrap.appendChild(node);
  });
}

function renderTopClients(list) {
  const box = $('#clientsList');
  if (!box) return;
  box.innerHTML = '';
  list.forEach(c => {
    const div = document.createElement('div');
    div.className = 'row';
    const name = c.name || '(No name)';
    const phone = c.phone || '(No phone)';
    div.innerHTML = `<span>${name} <span class="subtle">(${phone})</span></span><b>$ ${fmt(c.sales)}</b>`;
    box.appendChild(div);
  });
}

function renderTopItemsList(items) {
  const box = $('#itemsList');
  if (!box) return;
  box.innerHTML = '';
  items.slice(0, 10).forEach(i => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span>${i.code}</span><span class="subtle">qty ${fmt(i.qty)}</span><b>$ ${fmt(i.sales)}</b>`;
    box.appendChild(row);
  });
}

function renderCategories(topByCategory) {
  const wrap = $('#catsWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.entries(topByCategory).forEach(([cat, rows]) => {
    const item = document.createElement('div');
    item.className = 'acc-item';
    item.innerHTML = `
      <div class="acc-head"><span>${cat}</span><span class="subtle">Top 10</span></div>
      <div class="acc-body"><ul>${rows.map(r => `<li>${r.code} — qty ${fmt(r.qty)}</li>`).join('')}</ul></div>
    `;
    item.querySelector('.acc-head').addEventListener('click', () => {
      item.classList.toggle('acc-open');
    });
    wrap.appendChild(item);
  });
}

// ---------- main render ----------
async function render() {
  try {
    setStatus('Loading…');
    const data = await loadDataWithPolling();
    setStatus('');

    // header stats
    const salesEl = $('#totalSales');
    if (salesEl) salesEl.textContent = `Total Sales: $ ${fmt(data.totalSales)}`;

    // suppliers
    const sup = data.topSuppliers || [];
    const supSub = $('#suppliersSubtle');
    if (supSub) supSub.textContent = `${sup.length} suppliers`;
    makeBar('#suppliersChart',
      sup.slice(0, 8).map(s => s.supplier),
      sup.slice(0, 8).map(s => s.sales),
      'Sales');
    renderSupplierLogos(sup);

    // items
    const items = data.topItemsOverall || [];
    const itemsSub = $('#itemsSubtle');
    if (itemsSub) itemsSub.textContent = `${items.length} items ranked`;
    makeBar('#itemsChart',
      items.slice(0, 8).map(i => i.code),
      items.slice(0, 8).map(i => i.sales),
      'Sales');
    renderTopItemsList(items);

    // clients
    renderTopClients(data.topClients || []);

    // categories
    renderCategories(data.topByCategory || {});
  } catch (e) {
    console.error(e);
    setStatus('Failed to load data. Check Functions & Environment vars.');
    alert('Could not load aggregated data. Make sure warm-cache has run and that environment variables are set.');
  }
}

// wire up
document.addEventListener('DOMContentLoaded', render);
$('#refreshBtn')?.addEventListener('click', render);
