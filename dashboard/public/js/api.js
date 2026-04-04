// --- API client ---

const API = {
  getToken() {
    return localStorage.getItem('dashboard_token');
  },

  setToken(token) {
    localStorage.setItem('dashboard_token', token);
  },

  clearToken() {
    localStorage.removeItem('dashboard_token');
  },

  async auth(token) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error('Invalid token');
    return res.json();
  },

  async fetch(endpoint, params = {}) {
    const token = this.getToken();
    if (!token) {
      window.dispatchEvent(new Event('auth:logout'));
      throw new Error('No token');
    }

    const url = new URL(endpoint, window.location.origin);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      this.clearToken();
      window.dispatchEvent(new Event('auth:logout'));
      throw new Error('Unauthorized');
    }

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },
};
