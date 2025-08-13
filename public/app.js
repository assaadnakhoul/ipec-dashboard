// UI helper
const $ = sel => document.querySelector(sel);
const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

let charts = {};

// build a bar chart
function makeBar(id, labels, values, label) {
  const ctx = $(id).getContext('2d');
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
        x: { ticks: { color: '#cfd6f8' }, grid: { display:false } },
        y: { ticks: { color: '#8b93a7' }, grid: { color:'rgba(255,255,255,.05)' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: c => `${label}: $${fmt(c.parsed.y)}` }
        }
      }
    }
  });
}

async function loadData() {
  const res = await fetch('/.netlify/functions/get-agg', { cache: 'no-store' });
const json = await res.json();
if (!json.ready) throw new Error('Data not ready');
return json.data;

  if (!res.ok) throw new Error('agg.json not found');
  return res.json();
}

function renderSupplierLogos(suppliers) {
  const wrap = $('#supplierLogos');
  wrap.innerHTML = '';
  const tpl = $('#logoTpl');
  suppliers.slice(0, 8).forEach(s => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const img = node.querySelector('.logo-img');
    const cap = node.querySelector('figcaption');
    cap.textContent = s.supplier;
    const nameForFile = s.supplier.replace(/[^\w\-]+/g, '');
    img.src = `/images/logos/${nameForFile}.png`;
    img.alt = s.supplier;
    img.onerror = () => node.style.display = 'none';
    wrap.appendChild(node);
  });
}

function renderTopClients(list) {
  const box = $('#clientsList');
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

async function render() {
  try {
    const data = await loadData();

    // header stats
    $('#totalSales').textContent = `Total Sales: $ ${fmt(data.totalSales)}`;

    // suppliers
    const sup = data.topSuppliers || [];
    $('#suppliersSubtle').textContent = `${sup.length} suppliers`;
    makeBar('#suppliersChart',
      sup.slice(0,8).map(s => s.supplier),
      sup.slice(0,8).map(s => s.sales),
      'Sales');
    renderSupplierLogos(sup);

    // items
    const items = data.topItemsOverall || [];
    $('#itemsSubtle').textContent = `${items.length} items ranked`;
    makeBar('#itemsChart',
      items.slice(0,8).map(i => i.code),
      items.slice(0,8).map(i => i.sales),
      'Sales');
    renderTopItemsList(items);

    // clients
    renderTopClients(data.topClients || []);

    // categories
    renderCategories(data.topByCategory || {});
  } catch (e) {
    console.error(e);
    alert('Could not load /agg.json. Did the build create it?');
  }
}

document.addEventListener('DOMContentLoaded', render);
$('#refreshBtn')?.addEventListener('click', render);
