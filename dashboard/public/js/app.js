// --- Main application ---

let currentTab = 'overview';
let currentPeriod = '30d';
let feedInterval = null;

// Users page state
let usersPage = 1;
let usersSearch = '';
let usersSort = 'createdAt';
let usersOrder = 'desc';
let expandedUserId = null;

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

  // Reset users state on tab switch
  if (tab !== 'users') {
    usersPage = 1;
    usersSearch = '';
    expandedUserId = null;
  }

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
      case 'autostrategies': await renderAutoStrategies(content); break;
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
    <div class="kpi-grid kpi-grid-5">
      ${kpiCard('TOTAL USERS', data.totalUsers)}
      ${kpiCard('TOTAL TRADES', data.totalTrades)}
      ${kpiCard('TOTAL VOLUME', data.totalVolume, 'currency')}
      ${kpiCard('COMMISSION', data.totalCommission, 'currency')}
      ${kpiCard('ACTIVE SUBS', data.activeSubs)}
    </div>
    <div class="kpi-grid kpi-grid-5" style="margin-top: 16px;">
      ${kpiCard('FILLED', data.filledTrades)}
      ${kpiCard('FAILED', data.failedTrades)}
      ${kpiCard('SKIPPED', data.skippedTrades)}
      ${kpiCard('BOND STRATS', data.activeBondStrats)}
      ${kpiCard('UPDOWN STRATS', data.activeUpdownStrats)}
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
  const [statsData, listData] = await Promise.all([
    API.fetch('/api/stats/users', { period: currentPeriod }),
    API.fetch('/api/stats/users/list', { page: usersPage, limit: 25, search: usersSearch, sort: usersSort, order: usersOrder }),
  ]);

  const totalPages = Math.ceil(listData.total / listData.limit) || 1;

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('TOTAL USERS', statsData.kpis.totalUsers)}
      ${kpiCard('NEW TODAY', statsData.kpis.newToday)}
      ${kpiCard('NEW THIS WEEK', statsData.kpis.newWeek)}
      ${kpiCard('ACTIVE IN PERIOD', statsData.kpis.activeInPeriod)}
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
    <div class="section">
      <h3 class="section-title">USER LIST</h3>
      <div class="search-bar">
        <input type="text" id="user-search" placeholder="Search username, name, or telegram ID..." value="${escapeHtml(usersSearch)}">
      </div>
      <div id="users-table-container">
        ${renderUsersTable(listData.users)}
      </div>
      <div class="pagination">
        <button id="users-prev" ${usersPage <= 1 ? 'disabled' : ''}>PREV</button>
        <span>PAGE ${usersPage} OF ${totalPages}</span>
        <button id="users-next" ${usersPage >= totalPages ? 'disabled' : ''}>NEXT</button>
      </div>
    </div>
    <div id="user-detail-container"></div>
  `;

  // Charts
  if (statsData.newUsers.length) {
    createBarChart('chart-new-users',
      chartLabels(statsData.newUsers, currentPeriod),
      [{ label: 'New Users', data: statsData.newUsers.map(d => d.count) }]
    );
  }
  if (statsData.cumulative.length) {
    createLineChart('chart-cumulative-users',
      chartLabels(statsData.cumulative, currentPeriod),
      [{ label: 'Total Users', data: statsData.cumulative.map(d => Number(d.cumulative)) }]
    );
  }

  // Search handler
  let searchTimeout;
  document.getElementById('user-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      usersSearch = e.target.value.trim();
      usersPage = 1;
      reloadUsersTable();
    }, 400);
  });

  // Pagination
  document.getElementById('users-prev').addEventListener('click', () => {
    if (usersPage > 1) { usersPage--; reloadUsersTable(); }
  });
  document.getElementById('users-next').addEventListener('click', () => {
    if (usersPage < totalPages) { usersPage++; reloadUsersTable(); }
  });
}

async function reloadUsersTable() {
  const container = document.getElementById('users-table-container');
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const listData = await API.fetch('/api/stats/users/list', { page: usersPage, limit: 25, search: usersSearch, sort: usersSort, order: usersOrder });
    const totalPages = Math.ceil(listData.total / listData.limit) || 1;

    container.innerHTML = renderUsersTable(listData.users);

    // Update pagination
    const prevBtn = document.getElementById('users-prev');
    const nextBtn = document.getElementById('users-next');
    if (prevBtn) prevBtn.disabled = usersPage <= 1;
    if (nextBtn) nextBtn.disabled = usersPage >= totalPages;
    const pageSpan = document.querySelector('.pagination span');
    if (pageSpan) pageSpan.textContent = `PAGE ${usersPage} OF ${totalPages}`;

    // Rebind row click handlers
    bindUserRowClicks();
  } catch (err) {
    container.innerHTML = '<div class="error">Failed to load users</div>';
    console.error(err);
  }
}

function renderUsersTable(users) {
  if (!users || !users.length) return '<p class="empty">No users found</p>';

  const startIdx = (usersPage - 1) * 25;
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th><th>USER</th><th>TELEGRAM ID</th><th>REGISTERED</th>
          <th>REFERRER</th><th>REF CODE</th><th>REFERRALS</th><th>REF EARNED</th>
          <th>CASHBACK</th><th>STRATEGIES</th><th>VOLUME</th>
        </tr>
      </thead>
      <tbody>
        ${users.map((u, i) => {
          const stratCount = (u.copySubCount || 0) + (u.bondStratCount || 0) + (u.updownStratCount || 0);
          return `
            <tr class="clickable-row" data-user-id="${u.id}">
              <td>${startIdx + i + 1}</td>
              <td>${escapeHtml(u.username || u.firstName || '-')}</td>
              <td class="mono">${u.telegramId}</td>
              <td>${formatDate(u.createdAt)}</td>
              <td>${u.referredBy || '-'}</td>
              <td class="mono">${u.referralCode || '-'}</td>
              <td>${u.referralCount}</td>
              <td>${formatCurrency(u.referralEarnedTotal)}</td>
              <td>${formatCurrency(u.cashbackEarnedTotal)}</td>
              <td><span class="badge">${stratCount}</span></td>
              <td>${formatCurrency(u.totalTradeVolume)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function bindUserRowClicks() {
  document.querySelectorAll('.clickable-row[data-user-id]').forEach(row => {
    row.addEventListener('click', () => {
      const userId = row.dataset.userId;
      if (expandedUserId === userId) {
        expandedUserId = null;
        const detailContainer = document.getElementById('user-detail-container');
        if (detailContainer) detailContainer.innerHTML = '';
      } else {
        expandedUserId = userId;
        loadUserDetail(userId);
      }
    });
  });
}

// Bind initial rows after renderUsers completes
document.addEventListener('DOMContentLoaded', () => {
  // Use MutationObserver to bind clicks after table renders
  const observer = new MutationObserver(() => {
    bindUserRowClicks();
  });
  const content = document.getElementById('content');
  if (content) observer.observe(content, { childList: true, subtree: true });
});

async function loadUserDetail(userId) {
  const container = document.getElementById('user-detail-container');
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading user detail...</div>';

  try {
    const u = await API.fetch(`/api/stats/users/detail/${userId}`);

    container.innerHTML = `
      <div class="section" style="margin-top: 16px;">
        <h3 class="section-title">USER DETAIL: ${escapeHtml(u.username || u.firstName || u.telegramId)}</h3>
        <div class="user-detail-grid">
          <div class="user-detail-field"><div class="label">TELEGRAM ID</div><div class="value">${u.telegramId}</div></div>
          <div class="user-detail-field"><div class="label">NAME</div><div class="value">${escapeHtml((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '-'}</div></div>
          <div class="user-detail-field"><div class="label">USERNAME</div><div class="value">${u.username ? '@' + escapeHtml(u.username) : '-'}</div></div>
          <div class="user-detail-field"><div class="label">REGISTERED</div><div class="value">${formatDateTime(u.createdAt)}</div></div>
          <div class="user-detail-field"><div class="label">REFERRAL CODE</div><div class="value">${u.referralCode || '-'}</div></div>
          <div class="user-detail-field"><div class="label">REFERRED BY</div><div class="value">${u.referredBy ? escapeHtml(u.referredBy.username || u.referredBy.firstName || '-') : '-'}</div></div>
          <div class="user-detail-field"><div class="label">REFERRAL EARNED</div><div class="value">${formatCurrency(u.referralEarnedTotal)}</div></div>
          <div class="user-detail-field"><div class="label">CASHBACK EARNED</div><div class="value">${formatCurrency(u.cashbackEarnedTotal)}</div></div>
          <div class="user-detail-field"><div class="label">DEFAULT TRADE</div><div class="value">$${u.defaultTradeAmount}</div></div>
          <div class="user-detail-field"><div class="label">SLIPPAGE</div><div class="value">${u.slippageTolerance}%</div></div>
          <div class="user-detail-field"><div class="label">TRADING</div><div class="value">${u.tradingEnabled ? 'ENABLED' : 'DISABLED'}</div></div>
          <div class="user-detail-field"><div class="label">STATUS</div><div class="value">${u.isActive ? 'ACTIVE' : 'INACTIVE'}${u.isAdmin ? ' / ADMIN' : ''}</div></div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-top: 16px;">
          <div class="user-detail-field"><div class="label">COPY SUBS</div><div class="value">${u._count.copySubscriptions}</div></div>
          <div class="user-detail-field"><div class="label">COPIED TRADES</div><div class="value">${u._count.copiedTrades}</div></div>
          <div class="user-detail-field"><div class="label">BOND STRATS</div><div class="value">${u._count.bondStrategies}</div></div>
          <div class="user-detail-field"><div class="label">BOND TRADES</div><div class="value">${u._count.bondTrades}</div></div>
          <div class="user-detail-field"><div class="label">UPDOWN STRATS</div><div class="value">${u._count.updownStrategies}</div></div>
          <div class="user-detail-field"><div class="label">UPDOWN TRADES</div><div class="value">${u._count.updownTrades}</div></div>
          <div class="user-detail-field"><div class="label">REFERRALS</div><div class="value">${u._count.referrals}</div></div>
        </div>

        ${u.referrals && u.referrals.length > 0 ? `
          <h3 class="section-title" style="margin-top: 20px;">REFERRAL LIST</h3>
          <table class="data-table">
            <thead><tr><th>USER</th><th>TELEGRAM ID</th><th>REGISTERED</th></tr></thead>
            <tbody>
              ${u.referrals.map(r => `
                <tr>
                  <td>${escapeHtml(r.username || r.firstName || '-')}</td>
                  <td class="mono">${r.telegramId}</td>
                  <td>${formatDate(r.createdAt)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        ${u.recentCopied && u.recentCopied.length > 0 ? `
          <h3 class="section-title" style="margin-top: 20px;">RECENT COPIED TRADES</h3>
          <table class="data-table">
            <thead><tr><th>TIME</th><th>SIDE</th><th>OUTCOME</th><th>SIZE</th><th>PRICE</th><th>STATUS</th><th>TRADER</th></tr></thead>
            <tbody>
              ${u.recentCopied.map(t => `
                <tr>
                  <td>${timeAgo(t.createdAt)}</td>
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
        ` : ''}

        ${u.recentBond && u.recentBond.length > 0 ? `
          <h3 class="section-title" style="margin-top: 20px;">RECENT BOND TRADES</h3>
          <table class="data-table">
            <thead><tr><th>TIME</th><th>QUESTION</th><th>OUTCOME</th><th>AMOUNT</th><th>PROB</th><th>STATUS</th></tr></thead>
            <tbody>
              ${u.recentBond.map(t => `
                <tr>
                  <td>${timeAgo(t.createdAt)}</td>
                  <td>${escapeHtml(truncateText(t.question, 40))}</td>
                  <td>${t.outcome}</td>
                  <td>${formatCurrency(t.amount)}</td>
                  <td>${Number(t.probability).toFixed(1)}%</td>
                  <td><span class="status status-${t.status}">${t.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        ${u.recentUpdown && u.recentUpdown.length > 0 ? `
          <h3 class="section-title" style="margin-top: 20px;">RECENT UPDOWN TRADES</h3>
          <table class="data-table">
            <thead><tr><th>TIME</th><th>COIN</th><th>DIR</th><th>AMOUNT</th><th>TRIGGER</th><th>FILL</th><th>STATUS</th></tr></thead>
            <tbody>
              ${u.recentUpdown.map(t => `
                <tr>
                  <td>${timeAgo(t.createdAt)}</td>
                  <td>${t.coin}</td>
                  <td><span class="tag">${t.direction.toUpperCase()}</span></td>
                  <td>${formatCurrency(t.amount)}</td>
                  <td>${Number(t.triggerPrice).toFixed(4)}</td>
                  <td>${t.fillPrice ? Number(t.fillPrice).toFixed(4) : '-'}</td>
                  <td><span class="status status-${t.status}">${t.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div class="error">Failed to load user detail</div>';
    console.error(err);
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

// --- Auto Strategies ---
async function renderAutoStrategies(el) {
  const data = await API.fetch('/api/stats/auto-strategies', { period: currentPeriod });
  const k = data.kpis;

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-4">
      ${kpiCard('ACTIVE BOND', k.activeBond)}
      ${kpiCard('PAUSED BOND', k.pausedBond)}
      ${kpiCard('BOND TRADES', k.totalBondTrades)}
      ${kpiCard('BOND FILL RATE', k.bondFillRate + '%')}
    </div>
    <div class="kpi-grid kpi-grid-4" style="margin-top: 16px;">
      ${kpiCard('ACTIVE UPDOWN', k.activeUpdown)}
      ${kpiCard('PAUSED UPDOWN', k.pausedUpdown)}
      ${kpiCard('UPDOWN TRADES', k.totalUpdownTrades)}
      ${kpiCard('UPDOWN FILL RATE', k.updownFillRate + '%')}
    </div>
    <div class="chart-grid">
      <div class="chart-box">
        <h3 class="section-title">DAILY BOND TRADES</h3>
        <div class="chart-container"><canvas id="chart-daily-bond"></canvas></div>
      </div>
      <div class="chart-box">
        <h3 class="section-title">DAILY UPDOWN TRADES</h3>
        <div class="chart-container"><canvas id="chart-daily-updown"></canvas></div>
      </div>
    </div>
    <div class="section">
      <h3 class="section-title">TOP USERS BY STRATEGY COUNT</h3>
      ${renderTopStrategyUsers(data.topUsers)}
    </div>
  `;

  if (data.dailyBondTrades.length) {
    createBarChart('chart-daily-bond',
      chartLabels(data.dailyBondTrades, currentPeriod),
      [
        { label: 'Filled', data: data.dailyBondTrades.map(d => d.filled) },
        { label: 'Failed', data: data.dailyBondTrades.map(d => d.failed) },
      ],
      true
    );
  }
  if (data.dailyUpdownTrades.length) {
    createBarChart('chart-daily-updown',
      chartLabels(data.dailyUpdownTrades, currentPeriod),
      [
        { label: 'Filled', data: data.dailyUpdownTrades.map(d => d.filled) },
        { label: 'Failed', data: data.dailyUpdownTrades.map(d => d.failed) },
      ],
      true
    );
  }
}

function renderTopStrategyUsers(users) {
  if (!users || !users.length) return '<p class="empty">No active strategies</p>';
  return `
    <table class="data-table">
      <thead><tr><th>#</th><th>USER</th><th>BOND</th><th>UPDOWN</th><th>TOTAL</th></tr></thead>
      <tbody>
        ${users.map((u, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(u.username || u.firstName || '-')}</td>
            <td>${u.bond_count}</td>
            <td>${u.updown_count}</td>
            <td>${u.bond_count + u.updown_count}</td>
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

// --- Utility ---
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateText(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
