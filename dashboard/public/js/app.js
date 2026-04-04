// --- Main application ---

let currentTab = 'overview';
let currentPeriod = '30d';
let feedInterval = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  initClock();
  initAuth();
  initTabs();
  initPeriod();

  window.addEventListener('auth:logout', showLogin);
});

// --- Clock ---
function initClock() {
  const el = document.getElementById('live-clock');
  function tick() {
    el.textContent = formatTime(new Date());
  }
  tick();
  setInterval(tick, 1000);
}

// --- Auth ---
function initAuth() {
  const token = API.getToken();
  if (token) {
    showDashboard();
  } else {
    showLogin();
  }

  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('login-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('logout-btn').addEventListener('click', () => {
    API.clearToken();
    showLogin();
  });
}

async function doLogin() {
  const input = document.getElementById('login-token');
  const error = document.getElementById('login-error');
  const token = input.value.trim();
  if (!token) return;

  try {
    await API.auth(token);
    API.setToken(token);
    error.textContent = '';
    showDashboard();
  } catch {
    error.textContent = 'Invalid access token';
    input.value = '';
    input.focus();
  }
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  if (feedInterval) { clearInterval(feedInterval); feedInterval = null; }
}

function showDashboard() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');

  const hash = window.location.hash.slice(1) || 'overview';
  navigateTo(hash);
}

// --- Tabs ---
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(tab.dataset.tab);
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.slice(1) || 'overview';
    navigateTo(hash);
  });
}

function navigateTo(tab) {
  currentTab = tab;
  window.location.hash = tab;

  // Update active tab
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  // Clear feed polling
  if (feedInterval) { clearInterval(feedInterval); feedInterval = null; }

  // Render
  loadTab(tab);
}

// --- Period ---
function initPeriod() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPeriod = btn.dataset.period;
      document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b === btn));
      loadTab(currentTab);
    });
  });
}

// --- Tab loading ---
async function loadTab(tab) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    switch (tab) {
      case 'overview': await renderOverview(content); break;
      case 'users': await renderUsers(content); break;
      case 'trades': await renderTrades(content); break;
      case 'copytrade': await renderCopyTrade(content); break;
      case 'financials': await renderFinancials(content); break;
      default: content.innerHTML = '<p>Unknown tab</p>';
    }
  } catch (err) {
    content.innerHTML = `<div class="error">Failed to load data</div>`;
    console.error(err);
  }
}

// --- Overview ---
async function renderOverview(el) {
  const [data, feed] = await Promise.all([
    API.fetch('/api/stats/overview', { period: currentPeriod }),
    API.fetch('/api/feed/recent'),
  ]);

  el.innerHTML = `
    <div class="kpi-grid">
      ${kpiCard('TOTAL USERS', data.totalUsers)}
      ${kpiCard('TOTAL TRADES', data.totalTrades)}
      ${kpiCard('TOTAL VOLUME', data.totalVolume, 'currency')}
      ${kpiCard('COMMISSION', data.totalCommission, 'currency')}
      ${kpiCard('ACTIVE SUBS', data.activeSubs)}
    </div>
    <div class="kpi-grid kpi-grid-3" style="margin-top: 16px;">
      ${kpiCard('FILLED', data.filledTrades)}
      ${kpiCard('FAILED', data.failedTrades)}
      ${kpiCard('SKIPPED', data.skippedTrades)}
    </div>
    <div class="section">
      <h3 class="section-title">LIVE FEED</h3>
      <div id="live-feed">${renderFeedTable(feed)}</div>
    </div>
  `;

  // Start polling
  feedInterval = setInterval(async () => {
    try {
      const newFeed = await API.fetch('/api/feed/recent');
      const el = document.getElementById('live-feed');
      if (el) el.innerHTML = renderFeedTable(newFeed);
    } catch {}
  }, 10000);
}

function renderFeedTable(trades) {
  if (!trades.length) return '<p class="empty">No recent trades</p>';
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>TIME</th><th>USER</th><th>SIDE</th><th>OUTCOME</th>
          <th>SIZE</th><th>PRICE</th><th>STATUS</th><th>TRADER</th>
        </tr>
      </thead>
      <tbody>
        ${trades.map(t => `
          <tr>
            <td>${timeAgo(t.createdAt)}</td>
            <td>${t.user?.username || t.user?.firstName || '-'}</td>
            <td><span class="tag tag-${t.side.toLowerCase()}">${t.side}</span></td>
            <td>${t.outcome}</td>
            <td>${formatCurrency(t.copiedSize)}</td>
            <td>${Number(t.price).toFixed(2)}</td>
            <td><span class="status status-${t.status}">${t.status}</span></td>
            <td class="mono">${shortenAddress(t.traderAddress)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// --- Users ---
async function renderUsers(el) {
  const data = await API.fetch('/api/stats/users', { period: currentPeriod });

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('TOTAL USERS', data.kpis.totalUsers)}
      ${kpiCard('NEW TODAY', data.kpis.newToday)}
      ${kpiCard('NEW THIS WEEK', data.kpis.newWeek)}
      ${kpiCard('ACTIVE IN PERIOD', data.kpis.activeInPeriod)}
    </div>
    <div class="chart-grid">
      <div class="chart-box">
        <h3 class="section-title">NEW REGISTRATIONS</h3>
        <div class="chart-container"><canvas id="chart-new-users"></canvas></div>
      </div>
      <div class="chart-box">
        <h3 class="section-title">CUMULATIVE USERS</h3>
        <div class="chart-container"><canvas id="chart-cumulative-users"></canvas></div>
      </div>
    </div>
  `;

  if (data.newUsers.length) {
    createBarChart('chart-new-users',
      chartLabels(data.newUsers, currentPeriod),
      [{ label: 'New Users', data: data.newUsers.map(d => d.count) }]
    );
  }
  if (data.cumulative.length) {
    createLineChart('chart-cumulative-users',
      chartLabels(data.cumulative, currentPeriod),
      [{ label: 'Total Users', data: data.cumulative.map(d => Number(d.cumulative)) }]
    );
  }
}

// --- Trades ---
async function renderTrades(el) {
  const data = await API.fetch('/api/stats/trades', { period: currentPeriod });

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-5">
      ${kpiCard('TOTAL', data.kpis.total)}
      ${kpiCard('FILLED', data.kpis.filled)}
      ${kpiCard('FAILED', data.kpis.failed)}
      ${kpiCard('SKIPPED', data.kpis.skipped)}
      ${kpiCard('AVG SIZE', data.kpis.avgTradeSize, 'currency')}
    </div>
    <div class="chart-grid">
      <div class="chart-box">
        <h3 class="section-title">DAILY TRADE COUNT</h3>
        <div class="chart-container"><canvas id="chart-daily-trades"></canvas></div>
      </div>
      <div class="chart-box">
        <h3 class="section-title">DAILY VOLUME</h3>
        <div class="chart-container"><canvas id="chart-daily-volume"></canvas></div>
      </div>
    </div>
    <div class="section">
      <h3 class="section-title">STATUS BREAKDOWN</h3>
      <div class="chart-container chart-container-wide"><canvas id="chart-status"></canvas></div>
    </div>
  `;

  if (data.dailyCounts.length) {
    createBarChart('chart-daily-trades',
      chartLabels(data.dailyCounts, currentPeriod),
      [
        { label: 'Buys', data: data.dailyCounts.map(d => d.buys) },
        { label: 'Sells', data: data.dailyCounts.map(d => d.sells) },
      ],
      true
    );
  }
  if (data.dailyVolume.length) {
    createLineChart('chart-daily-volume',
      chartLabels(data.dailyVolume, currentPeriod),
      [{ label: 'Volume', data: data.dailyVolume.map(d => Number(d.volume)) }],
      'currency'
    );
  }
  if (data.statusBreakdown.length) {
    createBarChart('chart-status',
      chartLabels(data.statusBreakdown, currentPeriod),
      [
        { label: 'Filled', data: data.statusBreakdown.map(d => d.filled) },
        { label: 'Failed', data: data.statusBreakdown.map(d => d.failed) },
        { label: 'Skipped', data: data.statusBreakdown.map(d => d.skipped) },
      ],
      true
    );
  }
}

// --- Copy Trade ---
async function renderCopyTrade(el) {
  const data = await API.fetch('/api/stats/copy-trade', { period: currentPeriod });

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('ACTIVE SUBS', data.kpis.activeSubs)}
      ${kpiCard('PAUSED SUBS', data.kpis.pausedSubs)}
      ${kpiCard('TOTAL COPIED', data.kpis.totalCopied)}
      ${kpiCard('FILL RATE', data.kpis.fillRate + '%')}
    </div>
    <div class="chart-grid">
      <div class="chart-box">
        <h3 class="section-title">COPIED TRADES PER DAY</h3>
        <div class="chart-container"><canvas id="chart-daily-copied"></canvas></div>
      </div>
      <div class="chart-box">
        <h3 class="section-title">SUBSCRIPTIONS OVER TIME</h3>
        <div class="chart-container"><canvas id="chart-subs-time"></canvas></div>
      </div>
    </div>
    <div class="section">
      <h3 class="section-title">TOP TRACKED WALLETS</h3>
      ${renderWalletsTable(data.topWallets)}
    </div>
  `;

  if (data.dailyCopied.length) {
    createBarChart('chart-daily-copied',
      chartLabels(data.dailyCopied, currentPeriod),
      [
        { label: 'Filled', data: data.dailyCopied.map(d => d.filled) },
        { label: 'Failed', data: data.dailyCopied.map(d => d.failed) },
        { label: 'Skipped', data: data.dailyCopied.map(d => d.skipped) },
      ],
      true
    );
  }
  if (data.subsOverTime.length) {
    createBarChart('chart-subs-time',
      chartLabels(data.subsOverTime, currentPeriod),
      [
        { label: 'Active', data: data.subsOverTime.map(d => d.active) },
        { label: 'Paused', data: data.subsOverTime.map(d => d.paused) },
      ],
      true
    );
  }
}

function renderWalletsTable(wallets) {
  if (!wallets || !wallets.length) return '<p class="empty">No data</p>';
  return `
    <table class="data-table">
      <thead><tr><th>#</th><th>WALLET</th><th>TRADES</th></tr></thead>
      <tbody>
        ${wallets.map((w, i) => `
          <tr>
            <td>${i + 1}</td>
            <td class="mono">${shortenAddress(w.traderAddress)}</td>
            <td>${formatNumber(w.trade_count)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// --- Financials ---
async function renderFinancials(el) {
  const data = await API.fetch('/api/stats/financials', { period: currentPeriod });

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('TOTAL COMMISSION', data.kpis.totalCommission, 'currency')}
      ${kpiCard('TOTAL CASHBACK', data.kpis.totalCashback, 'currency')}
      ${kpiCard('TOTAL REFERRAL', data.kpis.totalReferral, 'currency')}
      ${kpiCard('NET REVENUE', data.kpis.netRevenue, 'currency')}
    </div>
    <div class="chart-grid">
      <div class="chart-box">
        <h3 class="section-title">DAILY COMMISSION</h3>
        <div class="chart-container"><canvas id="chart-daily-commission"></canvas></div>
      </div>
      <div class="chart-box">
        <h3 class="section-title">CUMULATIVE REVENUE</h3>
        <div class="chart-container"><canvas id="chart-cumulative-revenue"></canvas></div>
      </div>
    </div>
    <div class="section">
      <h3 class="section-title">RECENT COMMISSION LOGS</h3>
      ${renderCommissionTable(data.recentLogs)}
    </div>
  `;

  if (data.dailyCommission.length) {
    createBarChart('chart-daily-commission',
      chartLabels(data.dailyCommission, currentPeriod),
      [{ label: 'Commission', data: data.dailyCommission.map(d => Number(d.commission)) }],
      false,
      'currency'
    );
  }
  if (data.cumulativeRevenue.length) {
    createLineChart('chart-cumulative-revenue',
      chartLabels(data.cumulativeRevenue, currentPeriod),
      [{ label: 'Cumulative', data: data.cumulativeRevenue.map(d => Number(d.cumulative)) }],
      'currency'
    );
  }
}

function renderCommissionTable(logs) {
  if (!logs || !logs.length) return '<p class="empty">No logs</p>';
  return `
    <table class="data-table">
      <thead><tr><th>TIME</th><th>USER ID</th><th>AMOUNT</th></tr></thead>
      <tbody>
        ${logs.map(l => `
          <tr>
            <td>${timeAgo(l.createdAt)}</td>
            <td class="mono">${l.userId ? shortenAddress(l.userId) : '-'}</td>
            <td>${formatCurrency(l.amount)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// --- KPI card helper ---
function kpiCard(label, value, format) {
  let display;
  if (format === 'currency') {
    display = formatCurrency(value);
  } else if (typeof value === 'number') {
    display = formatNumber(value);
  } else {
    display = value;
  }

  return `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${display}</div>
    </div>
  `;
}
