// --- Number & date formatters ---

function formatNumber(n, decimals = 0) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatCurrency(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + formatNumber(n, 2);
}

function formatDate(d) {
  const date = new Date(d);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${String(date.getDate()).padStart(2,'0')} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function formatTime(d) {
  const date = new Date(d);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(d) {
  return formatDate(d) + ' ' + formatTime(d);
}

function timeAgo(d) {
  const now = Date.now();
  const diff = now - new Date(d).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.floor(hr / 24);
  return days + 'd ago';
}

function animateCounter(el, from, to, duration = 300) {
  const start = performance.now();
  const isFloat = String(to).includes('.') || el.dataset.decimals;
  const decimals = parseInt(el.dataset.decimals || '0');

  function step(ts) {
    const elapsed = ts - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = from + (to - from) * eased;

    if (el.dataset.format === 'currency') {
      el.textContent = formatCurrency(current);
    } else if (isFloat || decimals > 0) {
      el.textContent = formatNumber(current, decimals);
    } else {
      el.textContent = formatNumber(Math.round(current));
    }

    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function shortenAddress(addr) {
  if (!addr) return '-';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}
