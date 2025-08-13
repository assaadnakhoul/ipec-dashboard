const api = '/.netlify/functions/fetch-invoices';

const currency = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const tryImg = (basePath, name) => {
  const bases = [`${basePath}/${name}.jpg`, `${basePath}/${name}.png`, `${basePath}/${name}.webp`];
  return new Promise((resolve) => {
    (function test(i){
      if (i>=bases.length) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(bases[i]);
      img.onerror = () => test(i+1);
      img.src = bases[i];
    })(0);
  });
};

async function loadData(force=false) {
  const url = force ? `${api}?t=${Date.now()}` : api;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed loading data');
  return res.json();
}

function renderTotal(total) {
  document.getElementById('totalSales').textContent = `Total Sales: ${currency(total)}`;
}

function renderSuppliersChart(rows) {
  const ctx = document.getElementById('suppliersChart');
  const labels = rows.slice(0, 12).map(r => r.supplier);
  const data = rows.slice(0, 12).map(r => Math.round(r.sales));

  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Sales', data }] },
    options: {
      responsive: true,
      plugins: { legend: { display:false } },
      scales: { x: { ticks:{ color:'#cfe0ff' } }, y: { ticks:{ color:'#cfe0ff' } } }
    }
  });

  const logosDiv = document.getElementById('suppliersLogos');
  logosDiv.innerHTML = '';
  labels.forEach(async (name) => {
    const src = await tryImg('./logos', name);
    if (src) {
      const img = document.createElement('img');
      img.alt = name; img.src = src;
      logosDiv.appendChild(img);
    }
  });
}

async function renderTopItems(items) {
  const grid = document.getElementById('itemsGrid');
  grid.innerHTML = '';
  const top = items.slice(0, 24);
  for (const it of top) {
    const wrap = document.createElement('div');
    wrap.className = 'item';
    const src = await tryImg('./images', it.code);
    const img = document.createElement('img');
    img.src = src || '';
    img.alt = it.code;
    wrap.appendChild(img);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.code;
    wrap.appendChild(name);

    const fig = document.createElement('div');
    fig.className = 'fig';
    fig.textContent = `${it.qty} units • ${currency(it.sales)}`;
    wrap.appendChild(fig);

    grid.appendChild(wrap);
  }
}

async function renderCategories(topByCategory) {
  const host = document.getElementById('categories');
  host.innerHTML = '';

  for (const [cat, arr] of Object.entries(topByCategory)) {
    const section = document.createElement('div');
    section.className = 'category';
    const h = document.createElement('h3');
    h.textContent = cat;
    section.appendChild(h);

    const row = document.createElement('div');
    row.className = 'cat-row';
    section.appendChild(row);

    for (const it of arr) {
      const card = document.createElement('div');
      card.className = 'item';
      const src = await tryImg('./images', it.code);
      const img = document.createElement('img');
      img.src = src || '';
      img.alt = it.code;
      card.appendChild(img);

      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = it.code;
      card.appendChild(nm);

      const q = document.createElement('div');
      q.className = 'fig';
      q.textContent = `${it.qty} units`;
      card.appendChild(q);

      row.appendChild(card);
    }

    host.appendChild(section);
  }
}

async function boot(force=false){
  document.getElementById('itemsGrid').innerHTML = 'Loading…';
  try {
    const data = await loadData(force);
    renderTotal(data.totalSales || 0);
    renderSuppliersChart(data.topSuppliers || []);
    await renderTopItems(data.topItemsOverall || []);
    await renderCategories(data.topByCategory || {});
  } catch (e) {
    document.getElementById('itemsGrid').innerHTML = 'Error loading data.';
    console.error(e);
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => boot(true));
boot();
