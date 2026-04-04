// --- Chart.js monochrome theme ---

const CHART_COLORS = {
  primary: '#E8E2D9',
  secondary: 'rgba(232, 226, 217, 0.4)',
  tertiary: 'rgba(232, 226, 217, 0.2)',
  grid: 'rgba(232, 226, 217, 0.08)',
  green: 'rgba(232, 226, 217, 0.7)',
  red: 'rgba(232, 226, 217, 0.3)',
};

// Global defaults
Chart.defaults.color = 'rgba(232, 226, 217, 0.5)';
Chart.defaults.borderColor = CHART_COLORS.grid;
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.tooltip.backgroundColor = '#1A1A1A';
Chart.defaults.plugins.tooltip.titleColor = CHART_COLORS.primary;
Chart.defaults.plugins.tooltip.bodyColor = CHART_COLORS.primary;
Chart.defaults.plugins.tooltip.borderColor = 'rgba(232, 226, 217, 0.15)';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.cornerRadius = 0;
Chart.defaults.plugins.tooltip.padding = 8;
Chart.defaults.plugins.tooltip.titleFont = { family: "'JetBrains Mono', monospace", size: 11 };
Chart.defaults.plugins.tooltip.bodyFont = { family: "'JetBrains Mono', monospace", size: 11 };

// Chart instances cache
const chartInstances = {};

function destroyChart(id) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
    delete chartInstances[id];
  }
}

function createLineChart(canvasId, labels, datasets, yFormat) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const ds = datasets.map((d, i) => ({
    label: d.label || '',
    data: d.data,
    borderColor: i === 0 ? CHART_COLORS.primary : CHART_COLORS.secondary,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHoverBackgroundColor: CHART_COLORS.primary,
    tension: 0.3,
    borderDash: d.dashed ? [4, 4] : [],
  }));

  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8 },
        },
        y: {
          grid: { color: CHART_COLORS.grid, drawBorder: false },
          ticks: {
            maxTicksLimit: 5,
            callback: yFormat === 'currency'
              ? (v) => '$' + formatNumber(v)
              : (v) => formatNumber(v),
          },
        },
      },
    },
  });
}

function createBarChart(canvasId, labels, datasets, stacked, yFormat) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const colors = [CHART_COLORS.primary, CHART_COLORS.secondary, CHART_COLORS.tertiary];
  const ds = datasets.map((d, i) => ({
    label: d.label || '',
    data: d.data,
    backgroundColor: colors[i % colors.length],
    borderWidth: 0,
    borderRadius: 0,
  }));

  chartInstances[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: ds },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 8, padding: 12 } },
      },
      scales: {
        x: {
          stacked: !!stacked,
          grid: { display: false },
          ticks: { maxTicksLimit: 8 },
        },
        y: {
          stacked: !!stacked,
          grid: { color: CHART_COLORS.grid, drawBorder: false },
          ticks: {
            maxTicksLimit: 5,
            callback: yFormat === 'currency'
              ? (v) => '$' + formatNumber(v)
              : (v) => formatNumber(v),
          },
        },
      },
    },
  });
}

function formatChartDate(dateStr) {
  const d = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

function formatChartHour(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function chartLabels(data, period) {
  const formatter = period === '24h' ? formatChartHour : formatChartDate;
  return data.map(d => formatter(d.date));
}
