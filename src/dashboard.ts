// Webster Dashboard — self-contained HTML page served at /dashboard
// Provides capture controls, server status, and session history.

import { FAVICON_SVG } from './favicon.js'

export function buildDashboardHtml(port: number): string {
  const base = `http://localhost:${port}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webster Dashboard</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; }

.container { max-width: 960px; margin: 0 auto; padding: 24px; }

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid #333;
}
header h1 { font-size: 20px; color: #7ec8e3; font-weight: 600; }

.status-bar {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 13px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}
.status-dot.green { background: #6bdb6b; box-shadow: 0 0 4px #6bdb6b; }
.status-dot.red { background: #e06c75; box-shadow: 0 0 4px #e06c75; }
.status-dot.orange { background: #e5c07b; box-shadow: 0 0 4px #e5c07b; }
.status-item { color: #888; }
.status-item strong { color: #e0e0e0; }

/* Cards */
.card {
  background: #16213e;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
  border: 1px solid #2a2a3e;
}
.card h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #7ec8e3;
  margin-bottom: 12px;
}

/* Capture controls */
.capture-controls {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.capture-controls .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.capture-controls label {
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
}
.capture-controls input[type=text] {
  background: #1a1a2e;
  border: 1px solid #333;
  color: #e0e0e0;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  width: 200px;
}
.capture-controls input[type=text]:focus { border-color: #7ec8e3; outline: none; }
.checkbox-row {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 13px;
}
.checkbox-row label { color: #ccc; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.checkbox-row input[type=checkbox] { accent-color: #7ec8e3; }

button {
  background: #2a3a5e;
  border: none;
  color: #e0e0e0;
  padding: 8px 18px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: background 0.15s;
}
button:hover { background: #3a5a8a; }
button.primary { background: #3a7a5e; }
button.primary:hover { background: #4a9a6e; }
button.danger { background: #5a2a2e; }
button.danger:hover { background: #7a3a3e; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

/* Active capture */
.active-capture {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: #1e2a1e;
  border: 1px solid #3a5a3a;
  border-radius: 6px;
  margin-bottom: 12px;
}
.active-capture .rec-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e06c75;
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.active-capture .info { flex: 1; font-size: 13px; }
.active-capture .info .detail { color: #888; font-size: 12px; margin-top: 2px; }

/* Session list */
.session-list { list-style: none; }
.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #2a2a3e;
  font-size: 13px;
}
.session-item:last-child { border-bottom: none; }
.session-item .id { color: #7ec8e3; font-weight: 500; min-width: 70px; }
.session-item .date { color: #888; min-width: 140px; }
.session-item .stats { color: #aaa; flex: 1; }
.session-item .stats span { margin-right: 12px; }
.session-item .actions { display: flex; gap: 6px; }
.session-item .actions button { padding: 4px 10px; font-size: 12px; }

.empty { color: #555; font-size: 13px; padding: 12px 0; }

/* Responsive */
@media (max-width: 640px) {
  .capture-controls { flex-direction: column; align-items: stretch; }
  .capture-controls input[type=text] { width: 100%; }
}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Webster Dashboard</h1>
    <div class="status-bar" id="statusBar">
      <span class="status-item"><span class="status-dot" id="serverDot"></span> <span id="serverStatus">Checking...</span></span>
      <span class="status-item" id="browserStatus"></span>
      <span class="status-item" id="uptimeStatus"></span>
    </div>
  </header>

  <div class="card">
    <h2>Capture</h2>
    <div id="activeCapture" style="display:none"></div>
    <div id="captureForm">
      <div class="capture-controls">
        <div class="field">
          <label>URL Filter</label>
          <input type="text" id="urlFilter" placeholder="e.g. example.com">
        </div>
        <div class="checkbox-row">
          <label><input type="checkbox" id="includeInput" checked> Input</label>
          <label><input type="checkbox" id="recordFrames" checked> Frames</label>
        </div>
        <button class="primary" id="startBtn" onclick="startCapture()">Start Capture</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Sessions <span id="sessionCount" style="color:#888;font-size:12px;text-transform:none"></span></h2>
    <div style="margin-bottom:12px">
      <input type="text" id="sessionSearch" placeholder="Filter by ID, URL, status..." style="background:#1a1a2e;border:1px solid #333;color:#e0e0e0;padding:6px 10px;border-radius:4px;font-size:13px;font-family:inherit;width:100%">
    </div>
    <ul class="session-list" id="sessionList">
      <li class="empty">Loading...</li>
    </ul>
  </div>
</div>

<script>
(function() {
  const BASE = '${base}';
  let captureActive = false;

  // ─── Status polling ──────────────────────────────────────────────────
  async function pollStatus() {
    try {
      const res = await fetch(BASE + '/api/status');
      const s = await res.json();

      document.getElementById('serverDot').className = 'status-dot green';
      document.getElementById('serverStatus').textContent = 'Running :' + s.port;
      document.getElementById('uptimeStatus').textContent = 'Up ' + s.uptime;

      if (s.extensions.length > 0) {
        const browsers = s.extensions.map(e => e.browser + ' v' + e.version).join(', ');
        document.getElementById('browserStatus').innerHTML = '<span class="status-dot green"></span> ' + esc(browsers);
      } else {
        document.getElementById('browserStatus').innerHTML = '<span class="status-dot red"></span> No browser';
      }

      // Capture state
      if (s.capture.active) {
        captureActive = true;
        document.getElementById('captureForm').style.display = 'none';
        const ac = document.getElementById('activeCapture');
        ac.style.display = 'flex';
        ac.className = 'active-capture';
        ac.innerHTML =
          '<div class="rec-dot"></div>' +
          '<div class="info">' +
            '<div>Recording — ' + esc(s.capture.sessionId.slice(0, 8)) + '</div>' +
            '<div class="detail">' + s.capture.duration + ' — ' + s.capture.eventCount + ' events, ' + s.capture.frameCount + ' frames</div>' +
          '</div>' +
          '<button class="danger" onclick="stopCapture()">Stop</button>';
      } else {
        captureActive = false;
        document.getElementById('captureForm').style.display = '';
        document.getElementById('activeCapture').style.display = 'none';
      }
    } catch {
      document.getElementById('serverDot').className = 'status-dot red';
      document.getElementById('serverStatus').textContent = 'Not reachable';
      document.getElementById('browserStatus').textContent = '';
      document.getElementById('uptimeStatus').textContent = '';
    }
  }

  // ─── Session list ────────────────────────────────────────────────────
  let allSessions = [];

  async function loadSessions() {
    try {
      const res = await fetch(BASE + '/api/sessions');
      allSessions = await res.json();
      renderSessions();
    } catch {
      document.getElementById('sessionList').innerHTML = '<li class="empty">Failed to load sessions.</li>';
    }
  }

  function renderSessions() {
    const filter = (document.getElementById('sessionSearch').value || '').toLowerCase();
    const filtered = filter
      ? allSessions.filter(s => {
          const haystack = [s.id, s.name, s.status, s.startedAt, s.config?.urlFilter].filter(Boolean).join(' ').toLowerCase();
          return haystack.includes(filter);
        })
      : allSessions;

    const list = document.getElementById('sessionList');
    document.getElementById('sessionCount').textContent = '(' + filtered.length + (filter ? '/' + allSessions.length : '') + ')';

    if (filtered.length === 0) {
      list.innerHTML = '<li class="empty">' + (filter ? 'No matching sessions.' : 'No capture sessions yet.') + '</li>';
      return;
    }

    list.innerHTML = filtered.map(s => {
      const id = (s.id || '').slice(0, 8);
      const date = s.startedAt ? new Date(s.startedAt).toLocaleString() : '—';
      const events = s.eventCount || 0;
      const frames = s.frameCount || 0;
      const status = s.status || 'unknown';
      const name = s.name || '';
      const statusBadge = status === 'active' ? '<span style="color:#6bdb6b">active</span>'
        : status === 'abandoned' ? '<span style="color:#888">stale</span>' : '';
      const thumbHtml = frames > 0
        ? '<img src="' + BASE + '/replay/' + esc(s.id) + '/frame/frame_00001.jpg" style="height:32px;border-radius:3px;object-fit:cover;margin-right:4px" loading="lazy">'
        : '';
      const nameHtml = name
        ? '<span class="session-name" style="color:#7ec8e3;cursor:pointer" onclick="renameSession(\\'' + esc(s.id) + '\\')" title="Click to rename">' + esc(name) + '</span>'
        : '<span class="session-name" style="color:#555;cursor:pointer;font-style:italic" onclick="renameSession(\\'' + esc(s.id) + '\\')" title="Click to name">name...</span>';
      return '<li class="session-item">' +
        thumbHtml +
        '<span class="id">' + esc(id) + '</span>' +
        nameHtml +
        '<span class="date">' + esc(date) + ' ' + statusBadge + '</span>' +
        '<span class="stats">' +
          '<span>' + events + ' events</span>' +
          '<span>' + frames + ' frames</span>' +
        '</span>' +
        '<span class="actions">' +
          '<button onclick="openReplay(\\'' + esc(s.id) + '\\')">Replay</button>' +
          '<button onclick="copyReplayURL(\\'' + esc(s.id) + '\\')">Copy URL</button>' +
          '<button class="danger" onclick="deleteSession(\\'' + esc(s.id) + '\\')">Delete</button>' +
        '</span>' +
      '</li>';
    }).join('');
  }

  document.getElementById('sessionSearch').addEventListener('input', renderSessions);

  // ─── Actions (exposed globally) ──────────────────────────────────────
  window.startCapture = async function() {
    const btn = document.getElementById('startBtn');
    btn.disabled = true;
    btn.textContent = 'Starting...';
    try {
      await fetch(BASE + '/api/capture/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urlFilter: document.getElementById('urlFilter').value || undefined,
          includeInput: document.getElementById('includeInput').checked,
          recordFrames: document.getElementById('recordFrames').checked,
        }),
      });
      await pollStatus();
    } catch (e) {
      alert('Failed to start: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Start Capture';
  };

  window.stopCapture = async function() {
    try {
      await fetch(BASE + '/api/capture/stop', { method: 'POST' });
      await pollStatus();
      await loadSessions();
    } catch (e) {
      alert('Failed to stop: ' + e.message);
    }
  };

  window.openReplay = function(id) {
    window.open(BASE + '/replay/' + id, '_blank');
  };

  window.copyReplayURL = function(id) {
    navigator.clipboard.writeText(BASE + '/replay/' + id).catch(() => {});
  };

  window.renameSession = async function(id) {
    const session = allSessions.find(s => s.id === id);
    const current = session?.name || '';
    const name = prompt('Session name:', current);
    if (name === null) return; // cancelled
    try {
      await fetch(BASE + '/api/sessions/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      });
      await loadSessions();
    } catch (e) {
      alert('Failed to rename: ' + e.message);
    }
  };

  window.deleteSession = async function(id) {
    if (!confirm('Delete session ' + id.slice(0, 8) + '?')) return;
    try {
      await fetch(BASE + '/api/sessions/' + id, { method: 'DELETE' });
      await loadSessions();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  };

  function esc(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── Init ────────────────────────────────────────────────────────────
  pollStatus();
  loadSessions();
  setInterval(pollStatus, 2000);
  setInterval(loadSessions, 10000);
})();
</script>
</body>
</html>`;
}
