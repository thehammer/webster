import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { FAVICON_SVG } from './favicon.js'

// ─── Route handler ───────────────────────────────────────────────────────────

const SAFE_ID_RE = /^[0-9a-zA-Z_-]+$/
const FRAME_RE = /^frame_\d{5}\.jpg$/

export function handleReplayRequest(req: Request, capturesDir: string): Response {
  const url = new URL(req.url)
  const parts = url.pathname.slice(1).split('/') // ['replay', sessionId, ...rest]
  const sessionId = parts[1]

  if (!sessionId || !SAFE_ID_RE.test(sessionId)) {
    return new Response('Invalid session ID', { status: 400 })
  }

  const sessionDir = join(capturesDir, sessionId)
  if (!existsSync(sessionDir)) {
    return new Response('Session not found', { status: 404 })
  }

  const sub = parts[2] ?? ''

  if (sub === '' || sub === undefined) {
    return serveReplayPage(sessionId)
  }
  if (sub === 'meta') {
    return serveReplayMeta(sessionDir)
  }
  if (sub === 'events') {
    return serveReplayEvents(sessionDir)
  }
  if (sub === 'frames') {
    return serveReplayFrames(sessionDir)
  }
  if (sub === 'frame') {
    const filename = parts[3]
    if (!filename || !FRAME_RE.test(filename)) {
      return new Response('Invalid frame filename', { status: 400 })
    }
    return serveReplayFrame(sessionDir, filename)
  }

  return new Response('Not found', { status: 404 })
}

// ─── JSON API handlers ──────────────────────────────────────────────────────

function serveReplayMeta(sessionDir: string): Response {
  const metaPath = join(sessionDir, 'meta.json')
  if (!existsSync(metaPath)) return new Response('Meta not found', { status: 404 })
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  return Response.json(meta)
}

function serveReplayEvents(sessionDir: string): Response {
  const eventsPath = join(sessionDir, 'events.jsonl')
  if (!existsSync(eventsPath)) return Response.json([])
  const raw = readFileSync(eventsPath, 'utf-8')
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
  return Response.json(events)
}

function serveReplayFrames(sessionDir: string): Response {
  const metaPath = join(sessionDir, 'meta.json')
  const framesDir = join(sessionDir, 'frames')
  if (!existsSync(framesDir)) return Response.json([])

  let fps = 2
  let startedAt = 0
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    fps = meta.config?.fps ?? 2
    startedAt = new Date(meta.startedAt).getTime()
  } catch { /* use defaults */ }

  const files = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort()
  const intervalMs = Math.round(1000 / fps)
  const frames = files.map((filename, i) => ({
    filename,
    index: i + 1,
    timestamp: startedAt + i * intervalMs,
  }))

  return Response.json(frames)
}

function serveReplayFrame(sessionDir: string, filename: string): Response {
  const filePath = join(sessionDir, 'frames', filename)
  if (!existsSync(filePath)) return new Response('Frame not found', { status: 404 })
  return new Response(Bun.file(filePath), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  })
}

// ─── HTML replay page ────────────────────────────────────────────────────────

function serveReplayPage(sessionId: string): Response {
  return new Response(buildReplayHtml(sessionId), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function buildReplayHtml(sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webster Replay</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; overflow: hidden; height: 100vh; }

.layout {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  grid-template-columns: 1fr 1fr;
  grid-template-areas:
    "header header"
    "video  sidebar"
    "page   page"
    "controls controls";
  height: 100vh;
  gap: 1px;
  background: #2a2a3e;
}

.header {
  grid-area: header;
  background: #16213e;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #333;
  font-size: 13px;
}
.header h1 { font-size: 14px; font-weight: 600; color: #7ec8e3; }
.header .meta-info { color: #888; font-size: 12px; }

.video-panel {
  grid-area: video;
  background: #111;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  min-height: 0;
}
.video-panel canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
.video-panel .no-video { color: #555; font-size: 14px; }
.click-overlay {
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none;
}

.sidebar {
  grid-area: sidebar;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.panel-header {
  background: #16213e;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #7ec8e3;
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}

.network-panel {
  flex: 1;
  background: #1a1a2e;
  overflow-y: auto;
  min-height: 0;
  border-bottom: 1px solid #333;
}
.network-entry {
  display: flex;
  align-items: center;
  padding: 3px 12px;
  font-size: 11px;
  border-bottom: 1px solid #222;
  gap: 8px;
  opacity: 0.4;
  transition: opacity 0.15s;
}
.network-entry.active { opacity: 1; background: #1e2a4a; }
.network-entry.past { opacity: 0.7; }
.network-entry .method { color: #f7a072; font-weight: 600; min-width: 40px; }
.network-entry .status { min-width: 28px; text-align: right; }
.network-entry .status.ok { color: #6bdb6b; }
.network-entry .status.err { color: #e06c75; }
.network-entry .status.redir { color: #e5c07b; }
.network-entry .url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aaa; }
.network-entry .bar-container { width: 80px; height: 6px; background: #222; border-radius: 3px; flex-shrink: 0; }
.network-entry .bar { height: 100%; border-radius: 3px; background: #3a5a8a; min-width: 2px; }
.network-entry.active .bar { background: #7ec8e3; }
.network-entry .dur { min-width: 45px; text-align: right; color: #666; font-size: 10px; }

.console-panel {
  flex: 1;
  background: #1a1a2e;
  overflow-y: auto;
  min-height: 0;
  font-size: 11px;
}
.console-entry { padding: 3px 12px; border-bottom: 1px solid #222; opacity: 0.4; transition: opacity 0.15s; }
.console-entry.visible { opacity: 1; }
.console-entry.level-error, .console-entry.level-exception { color: #e06c75; }
.console-entry.level-warn { color: #e5c07b; }
.console-entry.level-info { color: #61afef; }
.console-entry.level-log { color: #abb2bf; }
.console-entry .time { color: #555; margin-right: 8px; }
.console-entry .text { word-break: break-all; }

.page-bar {
  grid-area: page;
  background: #16213e;
  padding: 6px 16px;
  font-size: 11px;
  display: flex;
  gap: 16px;
  align-items: center;
  border-top: 1px solid #333;
  border-bottom: 1px solid #333;
  overflow: hidden;
}
.page-bar .page-url { color: #7ec8e3; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-bar .page-title { color: #888; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-bar .page-detail { color: #555; }

.controls {
  grid-area: controls;
  background: #16213e;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.controls button {
  background: #2a3a5e;
  border: none;
  color: #e0e0e0;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.controls button:hover { background: #3a5a8a; }
.controls button.active { background: #7ec8e3; color: #111; }
.controls .speed { font-size: 12px; color: #888; min-width: 36px; text-align: center; }
.timeline-container {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}
.timeline-container input[type=range] {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 6px;
  background: #333;
  border-radius: 3px;
  outline: none;
}
.timeline-container input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #7ec8e3;
  cursor: pointer;
}
.time-display { font-size: 12px; color: #888; min-width: 110px; text-align: right; font-variant-numeric: tabular-nums; }

.input-markers {
  position: absolute;
  top: -8px;
  left: 0;
  right: 0;
  height: 6px;
  pointer-events: none;
}
.input-marker {
  position: absolute;
  width: 3px;
  height: 6px;
  border-radius: 1px;
  transform: translateX(-1px);
}
.input-marker.click { background: #e06c75; }
.input-marker.key { background: #e5c07b; }

.loading { display: flex; align-items: center; justify-content: center; height: 100vh; font-size: 16px; color: #555; }

/* scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: #1a1a2e; }
::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
</style>
</head>
<body>
<div id="loading" class="loading">Loading session...</div>
<div id="app" class="layout" style="display:none">
  <div class="header">
    <h1>Webster Replay</h1>
    <span class="meta-info" id="metaInfo"></span>
  </div>

  <div class="video-panel" id="videoPanel">
    <canvas id="videoCanvas"></canvas>
    <canvas id="clickCanvas" class="click-overlay"></canvas>
    <div class="no-video" id="noVideo" style="display:none">No video recorded</div>
  </div>

  <div class="sidebar">
    <div class="panel-header">Network <span id="networkCount"></span></div>
    <div class="network-panel" id="networkPanel"></div>
    <div class="panel-header">Console <span id="consoleCount"></span></div>
    <div class="console-panel" id="consolePanel"></div>
  </div>

  <div class="page-bar">
    <span class="page-url" id="pageUrl">—</span>
    <span class="page-title" id="pageTitle"></span>
    <span class="page-detail" id="pageDetail"></span>
  </div>

  <div class="controls">
    <button id="playBtn" title="Space">▶</button>
    <button id="speedBtn" class="speed" title="< / >">1x</button>
    <div class="timeline-container">
      <div class="input-markers" id="inputMarkers"></div>
      <input type="range" id="timeline" min="0" max="1000" value="0" step="1">
    </div>
    <span class="time-display" id="timeDisplay">0:00.0 / 0:00.0</span>
  </div>
</div>

<script>
(function() {
  const SESSION_ID = '${sessionId}';
  const BASE = '/replay/' + SESSION_ID;

  // ─── State ──────────────────────────────────────────────────────────────
  let meta = null;
  let frames = [];
  let events = [];
  let networkEvents = [];
  let inputEvents = [];
  let consoleEvents = [];
  let pageEvents = [];

  let sessionStart = 0;
  let sessionDuration = 1;
  let currentTime = 0; // ms offset from sessionStart
  let playing = false;
  let lastWallTime = 0;
  let playbackSpeed = 1;
  let rafHandle = null;

  const SPEEDS = [0.25, 0.5, 1, 2, 4];
  let speedIndex = 2;

  // Frame image cache
  const imageCache = new Map();
  let lastFrameIndex = -1;

  // ─── Elements ───────────────────────────────────────────────────────────
  const $loading = document.getElementById('loading');
  const $app = document.getElementById('app');
  const $metaInfo = document.getElementById('metaInfo');
  const $videoCanvas = document.getElementById('videoCanvas');
  const $clickCanvas = document.getElementById('clickCanvas');
  const $noVideo = document.getElementById('noVideo');
  const $videoPanel = document.getElementById('videoPanel');
  const $networkPanel = document.getElementById('networkPanel');
  const $networkCount = document.getElementById('networkCount');
  const $consolePanel = document.getElementById('consolePanel');
  const $consoleCount = document.getElementById('consoleCount');
  const $pageUrl = document.getElementById('pageUrl');
  const $pageTitle = document.getElementById('pageTitle');
  const $pageDetail = document.getElementById('pageDetail');
  const $playBtn = document.getElementById('playBtn');
  const $speedBtn = document.getElementById('speedBtn');
  const $timeline = document.getElementById('timeline');
  const $timeDisplay = document.getElementById('timeDisplay');
  const $inputMarkers = document.getElementById('inputMarkers');

  const vCtx = $videoCanvas.getContext('2d');
  const cCtx = $clickCanvas.getContext('2d');

  // ─── Load data ──────────────────────────────────────────────────────────
  async function load() {
    try {
      const [metaRes, eventsRes, framesRes] = await Promise.all([
        fetch(BASE + '/meta'),
        fetch(BASE + '/events'),
        fetch(BASE + '/frames'),
      ]);
      meta = await metaRes.json();
      events = await eventsRes.json();
      frames = await framesRes.json();
    } catch (e) {
      $loading.textContent = 'Failed to load session: ' + e.message;
      return;
    }

    sessionStart = new Date(meta.startedAt).getTime();
    const endTime = meta.finishedAt ? new Date(meta.finishedAt).getTime() : sessionStart;
    // Use the latest event timestamp or meta end time, whichever is later
    const lastEventTime = events.length > 0 ? Math.max(...events.slice(-20).map(e => e.timestamp || 0)) : 0;
    sessionDuration = Math.max(endTime - sessionStart, lastEventTime - sessionStart, 1000);

    // Sort events by timestamp and split by kind
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    networkEvents = events.filter(e => e.kind === 'network');
    inputEvents = events.filter(e => e.kind === 'input');
    consoleEvents = events.filter(e => e.kind === 'console');
    pageEvents = events.filter(e => e.kind === 'page');

    // Compute network bar widths
    const maxDur = Math.max(...networkEvents.map(e => e.duration || 0), 1);
    networkEvents.forEach(e => { e._barPct = Math.max(((e.duration || 0) / maxDur) * 100, 2); });

    setupUI();
    $loading.style.display = 'none';
    $app.style.display = '';
    renderAll();
  }

  // ─── UI setup ───────────────────────────────────────────────────────────
  function setupUI() {
    // Header
    const dur = formatTime(sessionDuration);
    $metaInfo.textContent = meta.id.slice(0, 8) + ' — ' + dur + ' — ' +
      events.length + ' events, ' + frames.length + ' frames';

    // Video
    if (frames.length === 0) {
      $videoCanvas.style.display = 'none';
      $clickCanvas.style.display = 'none';
      $noVideo.style.display = '';
    }

    // Build network panel
    $networkCount.textContent = '(' + networkEvents.length + ')';
    const netFrag = document.createDocumentFragment();
    networkEvents.forEach((evt, i) => {
      const row = document.createElement('div');
      row.className = 'network-entry';
      row.dataset.index = i;
      const status = evt.status || '—';
      const statusClass = status >= 400 ? 'err' : status >= 300 ? 'redir' : 'ok';
      let shortUrl = evt.url || '';
      try { shortUrl = new URL(evt.url).pathname; } catch {}
      row.innerHTML =
        '<span class="method">' + esc(evt.method || '?') + '</span>' +
        '<span class="status ' + statusClass + '">' + status + '</span>' +
        '<span class="url" title="' + esc(evt.url || '') + '">' + esc(shortUrl) + '</span>' +
        '<span class="bar-container"><span class="bar" style="width:' + (evt._barPct || 2) + '%"></span></span>' +
        '<span class="dur">' + (evt.duration ? evt.duration + 'ms' : '—') + '</span>';
      netFrag.appendChild(row);
    });
    $networkPanel.appendChild(netFrag);

    // Build console panel
    $consoleCount.textContent = '(' + consoleEvents.length + ')';
    const conFrag = document.createDocumentFragment();
    consoleEvents.forEach((evt, i) => {
      const row = document.createElement('div');
      row.className = 'console-entry level-' + (evt.level || 'log');
      row.dataset.index = i;
      const time = evt.time || new Date(evt.timestamp).toISOString();
      const short = time.slice(11, 23);
      row.innerHTML =
        '<span class="time">' + short + '</span>' +
        '<span class="text">' + esc(evt.text || '') + '</span>';
      conFrag.appendChild(row);
    });
    $consolePanel.appendChild(conFrag);

    // Build input markers on timeline
    const clickEvents = inputEvents.filter(e => e.inputType === 'click' || e.type === 'click');
    const keyEvents = inputEvents.filter(e => (e.inputType || e.type || '').startsWith('key'));
    clickEvents.forEach(e => {
      const pct = ((e.timestamp - sessionStart) / sessionDuration) * 100;
      if (pct < 0 || pct > 100) return;
      const m = document.createElement('div');
      m.className = 'input-marker click';
      m.style.left = pct + '%';
      $inputMarkers.appendChild(m);
    });
    keyEvents.slice(0, 200).forEach(e => { // cap markers to avoid DOM overload
      const pct = ((e.timestamp - sessionStart) / sessionDuration) * 100;
      if (pct < 0 || pct > 100) return;
      const m = document.createElement('div');
      m.className = 'input-marker key';
      m.style.left = pct + '%';
      $inputMarkers.appendChild(m);
    });

    // Controls
    $playBtn.addEventListener('click', togglePlay);
    $speedBtn.addEventListener('click', cycleSpeed);
    $timeline.addEventListener('input', onScrub);

    document.addEventListener('keydown', onKeydown);

    // Resize canvas when video panel resizes
    const ro = new ResizeObserver(() => sizeCanvases());
    ro.observe($videoPanel);
  }

  function sizeCanvases() {
    // Match canvas element size to the panel, but keep drawing resolution
    // tied to the actual frame size for crisp rendering
  }

  // ─── Playback ───────────────────────────────────────────────────────────
  function togglePlay() {
    playing = !playing;
    $playBtn.textContent = playing ? '⏸' : '▶';
    if (playing) {
      if (currentTime >= sessionDuration) currentTime = 0;
      lastWallTime = performance.now();
      rafHandle = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafHandle);
    }
  }

  function cycleSpeed() {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    playbackSpeed = SPEEDS[speedIndex];
    $speedBtn.textContent = playbackSpeed + 'x';
  }

  function onScrub() {
    currentTime = ($timeline.value / 1000) * sessionDuration;
    if (playing) {
      lastWallTime = performance.now();
    }
    renderAll();
  }

  function tick(wallNow) {
    if (!playing) return;
    const elapsed = (wallNow - lastWallTime) * playbackSpeed;
    lastWallTime = wallNow;
    currentTime = Math.min(currentTime + elapsed, sessionDuration);
    $timeline.value = Math.round((currentTime / sessionDuration) * 1000);
    renderAll();
    if (currentTime >= sessionDuration) {
      playing = false;
      $playBtn.textContent = '▶';
    } else {
      rafHandle = requestAnimationFrame(tick);
    }
  }

  function onKeydown(e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        currentTime = Math.max(0, currentTime - 5000);
        $timeline.value = Math.round((currentTime / sessionDuration) * 1000);
        renderAll();
        break;
      case 'ArrowRight':
        e.preventDefault();
        currentTime = Math.min(sessionDuration, currentTime + 5000);
        $timeline.value = Math.round((currentTime / sessionDuration) * 1000);
        renderAll();
        break;
      case '<': case ',':
        speedIndex = Math.max(0, speedIndex - 1);
        playbackSpeed = SPEEDS[speedIndex];
        $speedBtn.textContent = playbackSpeed + 'x';
        break;
      case '>': case '.':
        speedIndex = Math.min(SPEEDS.length - 1, speedIndex + 1);
        playbackSpeed = SPEEDS[speedIndex];
        $speedBtn.textContent = playbackSpeed + 'x';
        break;
      case 'Home':
        currentTime = 0;
        $timeline.value = 0;
        renderAll();
        break;
      case 'End':
        currentTime = sessionDuration;
        $timeline.value = 1000;
        renderAll();
        break;
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  function renderAll() {
    renderVideo();
    renderClickOverlay();
    renderNetwork();
    renderConsole();
    renderPageState();
    renderTime();
  }

  function renderVideo() {
    if (frames.length === 0) return;
    const absTime = sessionStart + currentTime;
    const fi = bsearch(frames, absTime, f => f.timestamp);
    if (fi === lastFrameIndex) return;
    lastFrameIndex = fi;

    const frame = frames[fi];
    const cached = imageCache.get(frame.filename);
    if (cached && cached.complete && cached.naturalWidth > 0) {
      drawFrame(cached);
    } else if (!cached) {
      const img = new Image();
      img.src = BASE + '/frame/' + frame.filename;
      img.onload = () => { if (lastFrameIndex === fi) drawFrame(img); };
      imageCache.set(frame.filename, img);
    }

    // Preload next few frames
    for (let i = fi + 1; i < Math.min(fi + 4, frames.length); i++) {
      const f = frames[i];
      if (!imageCache.has(f.filename)) {
        const img = new Image();
        img.src = BASE + '/frame/' + f.filename;
        imageCache.set(f.filename, img);
      }
    }
  }

  function drawFrame(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if ($videoCanvas.width !== w || $videoCanvas.height !== h) {
      $videoCanvas.width = w;
      $videoCanvas.height = h;
      $clickCanvas.width = w;
      $clickCanvas.height = h;
    }
    vCtx.drawImage(img, 0, 0);
  }

  function renderClickOverlay() {
    if (frames.length === 0) return;
    const w = $clickCanvas.width;
    const h = $clickCanvas.height;
    if (w === 0) return;
    cCtx.clearRect(0, 0, w, h);

    const absTime = sessionStart + currentTime;
    const windowMs = 1500;

    // Get viewport dimensions from nearest page event
    let vpW = 1280, vpH = 800;
    const pi = bsearch(pageEvents, absTime, e => e.timestamp);
    if (pi >= 0 && pageEvents[pi]) {
      vpW = pageEvents[pi].viewportWidth || vpW;
      vpH = pageEvents[pi].viewportHeight || vpH;
    }

    const clicks = inputEvents.filter(e => {
      if ((e.inputType || e.type) !== 'click') return false;
      const t = e.timestamp;
      return t >= absTime - windowMs && t <= absTime + 300;
    });

    clicks.forEach(c => {
      const x = ((c.x || 0) / vpW) * w;
      const y = ((c.y || 0) / vpH) * h;
      const age = Math.abs(absTime - c.timestamp);
      const alpha = Math.max(0.2, 1 - age / windowMs);
      const radius = 8 + (age / windowMs) * 6;

      cCtx.beginPath();
      cCtx.arc(x, y, radius, 0, Math.PI * 2);
      cCtx.fillStyle = 'rgba(224, 108, 117, ' + alpha + ')';
      cCtx.fill();
      cCtx.strokeStyle = 'rgba(255, 255, 255, ' + (alpha * 0.6) + ')';
      cCtx.lineWidth = 1.5;
      cCtx.stroke();
    });
  }

  let lastNetworkHighlight = -1;
  function renderNetwork() {
    const absTime = sessionStart + currentTime;
    const rows = $networkPanel.children;
    let scrollTarget = null;
    for (let i = 0; i < networkEvents.length; i++) {
      const evt = networkEvents[i];
      const start = evt.timestamp;
      const end = start + (evt.duration || 0);
      const row = rows[i];
      if (!row) continue;
      if (absTime >= start && absTime <= end + 500) {
        row.className = 'network-entry active';
        scrollTarget = row;
      } else if (absTime > end) {
        row.className = 'network-entry past';
      } else {
        row.className = 'network-entry';
      }
    }
    if (scrollTarget && scrollTarget !== lastNetworkHighlight) {
      scrollTarget.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      lastNetworkHighlight = scrollTarget;
    }
  }

  function renderConsole() {
    const absTime = sessionStart + currentTime;
    const rows = $consolePanel.children;
    let scrollTarget = null;
    for (let i = 0; i < consoleEvents.length; i++) {
      const evt = consoleEvents[i];
      const row = rows[i];
      if (!row) continue;
      if (evt.timestamp <= absTime) {
        row.className = row.className.replace(' visible', '') + ' visible';
        scrollTarget = row;
      } else {
        row.className = row.className.replace(' visible', '');
      }
    }
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  function renderPageState() {
    const absTime = sessionStart + currentTime;
    const pi = bsearch(pageEvents, absTime, e => e.timestamp);
    if (pi < 0 || !pageEvents[pi]) {
      $pageUrl.textContent = '—';
      $pageTitle.textContent = '';
      $pageDetail.textContent = '';
      return;
    }
    const p = pageEvents[pi];
    $pageUrl.textContent = p.url || '—';
    $pageTitle.textContent = p.title ? '"' + p.title + '"' : '';
    $pageDetail.textContent = 'Scroll: ' + (p.scrollX || 0) + ',' + (p.scrollY || 0) +
      '  |  ' + (p.viewportWidth || '?') + 'x' + (p.viewportHeight || '?');
  }

  function renderTime() {
    $timeDisplay.textContent = formatTime(currentTime) + ' / ' + formatTime(sessionDuration);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  // Binary search: find largest index where accessor(arr[i]) <= target
  function bsearch(arr, target, accessor) {
    if (arr.length === 0) return -1;
    let lo = 0, hi = arr.length - 1, result = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (accessor(arr[mid]) <= target) { result = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return result;
  }

  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const tenth = Math.floor((ms % 1000) / 100);
    return min + ':' + String(sec).padStart(2, '0') + '.' + tenth;
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Init ───────────────────────────────────────────────────────────────
  load();
})();
</script>
</body>
</html>`;
}
