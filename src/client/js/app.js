// State
let ws = null;
let config = null;
let currentRunId = null;
let runs = [];
let sessions = [];

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const workspaceSelect = document.getElementById('workspace');
const sessionSelect = document.getElementById('session');
const sessionInfo = document.getElementById('sessionInfo');
const promptInput = document.getElementById('prompt');
const validationInput = document.getElementById('validation');
const imageInstructionsInput = document.getElementById('imageInstructions');
const submitBtn = document.getElementById('submitBtn');
const runsList = document.getElementById('runsList');
const runDetail = document.getElementById('runDetail');
const notificationBanner = document.getElementById('notificationBanner');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupNavigation();
  setupWebSocket();
  await loadConfig();
  await loadRuns();
  setupForm();
  setupNotifications();
}

// Load sessions for a workspace
async function loadSessions(workspaceId) {
  try {
    const url = workspaceId ? `/api/sessions?workspaceId=${workspaceId}` : '/api/sessions';
    const res = await fetch(url);
    const data = await res.json();
    sessions = data.sessions || [];
    populateSessions();
  } catch (error) {
    console.error('Failed to load sessions:', error);
    sessions = [];
    populateSessions();
  }
}

// Navigation
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });
}

function switchView(viewName) {
  // Update nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Update views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });

  // Refresh data when switching views
  if (viewName === 'history') {
    loadRuns();
  } else if (viewName === 'current' && currentRunId) {
    loadRunDetail(currentRunId);
  }
}

// WebSocket
function setupWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    updateConnectionStatus('connected');
  };

  ws.onclose = () => {
    updateConnectionStatus('disconnected');
    // Reconnect after delay
    setTimeout(setupWebSocket, 3000);
  };

  ws.onerror = () => {
    updateConnectionStatus('disconnected');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleWsEvent(data);
  };
}

function updateConnectionStatus(status) {
  const dot = connectionStatus.querySelector('.status-dot');
  const text = connectionStatus.querySelector('.status-text');

  dot.className = 'status-dot ' + status;
  text.textContent = status === 'connected' ? 'Connected' : 
                     status === 'disconnected' ? 'Disconnected' : 'Connecting...';
}

function handleWsEvent(event) {
  // Update current run view if viewing this run
  if (currentRunId === event.runId) {
    loadRunDetail(event.runId);
  }

  // Handle specific events
  switch (event.type) {
    case 'complete':
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      loadRuns();
      loadSessions(workspaceSelect.value);  // Refresh sessions
      break;
    case 'phase':
      // If a run just started, switch to current view
      if (event.phase === 'prompt' && !currentRunId) {
        currentRunId = event.runId;
        switchView('current');
      }
      break;
  }
}

// API
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    populateWorkspaces();
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function loadRuns() {
  try {
    const res = await fetch('/api/runs');
    const data = await res.json();
    runs = data.runs || [];
    renderRunsList();
  } catch (error) {
    console.error('Failed to load runs:', error);
  }
}

async function loadRunDetail(runId) {
  try {
    const res = await fetch(`/api/runs/${runId}`);
    const data = await res.json();
    if (data.run) {
      currentRunId = runId;
      renderRunDetail(data.run);
    }
  } catch (error) {
    console.error('Failed to load run:', error);
  }
}

// Form
function setupForm() {
  submitBtn.addEventListener('click', submitRun);
}

function populateWorkspaces() {
  workspaceSelect.innerHTML = '';
  
  if (!config?.workspaces?.length) {
    workspaceSelect.innerHTML = '<option value="">No workspaces configured</option>';
    return;
  }

  config.workspaces.forEach(ws => {
    const option = document.createElement('option');
    option.value = ws.id;
    option.textContent = ws.name;
    workspaceSelect.appendChild(option);
  });
  
  // Load sessions and defaults for first workspace
  if (config.workspaces.length > 0) {
    loadSessions(config.workspaces[0].id);
    loadWorkspaceDefaults(config.workspaces[0].id);
  }
  
  // Reload sessions and defaults when workspace changes
  workspaceSelect.addEventListener('change', () => {
    const wsId = workspaceSelect.value;
    loadSessions(wsId);
    loadWorkspaceDefaults(wsId);
  });
}

// Load workspace default prompts into UI
function loadWorkspaceDefaults(workspaceId) {
  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return;
  
  // Load workspace defaults into the form
  validationInput.value = workspace.validationPrompt || '';
  imageInstructionsInput.value = workspace.outputPrompt || '';
}

function populateSessions() {
  sessionSelect.innerHTML = '<option value="">✨ New Session</option>';
  
  sessions.forEach(session => {
    const option = document.createElement('option');
    option.value = session.id;
    option.textContent = `📂 ${session.id.slice(0, 8)}... - ${session.lastPrompt.slice(0, 30)}...`;
    sessionSelect.appendChild(option);
  });
  
  // Show/hide session info
  sessionSelect.addEventListener('change', updateSessionInfo);
  updateSessionInfo();
}

function updateSessionInfo() {
  const selectedId = sessionSelect.value;
  if (!selectedId) {
    sessionInfo.hidden = true;
    return;
  }
  
  const session = sessions.find(s => s.id === selectedId);
  if (session) {
    sessionInfo.textContent = `Last used: ${formatTime(session.updatedAt)} | "${session.lastPrompt}"`;
    sessionInfo.hidden = false;
  } else {
    sessionInfo.hidden = true;
  }
}

async function submitRun() {
  const workspaceId = workspaceSelect.value;
  const prompt = promptInput.value.trim();
  const continueSession = sessionSelect.value || undefined;
  
  if (!workspaceId || !prompt) {
    alert('Please select a workspace and enter a prompt');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.classList.add('loading');

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        prompt,
        validationInstructions: validationInput.value.trim(),
        imageInstructions: imageInstructionsInput.value.trim(),
        continueSession,
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      alert(data.error);
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      return;
    }

    currentRunId = data.runId;
    switchView('current');
    
    // Clear form
    promptInput.value = '';
    validationInput.value = '';
    imageInstructionsInput.value = '';

  } catch (error) {
    console.error('Failed to start run:', error);
    alert('Failed to start run');
    submitBtn.disabled = false;
    submitBtn.classList.remove('loading');
  }
}

// Rendering
function renderRunsList() {
  if (!runs.length) {
    runsList.innerHTML = '<p class="empty-state">No runs yet. Start one!</p>';
    return;
  }

  runsList.innerHTML = runs.map(run => `
    <div class="run-item" data-run-id="${run.id}">
      <div class="run-item-header">
        <span class="run-workspace">${escapeHtml(run.workspaceName)}</span>
        <span class="run-status ${run.status}">${run.status}</span>
      </div>
      <p class="run-prompt">${escapeHtml(run.prompt)}</p>
      <p class="run-time">${formatTime(run.createdAt)}</p>
    </div>
  `).join('');

  // Add click handlers
  runsList.querySelectorAll('.run-item').forEach(item => {
    item.addEventListener('click', () => {
      const runId = item.dataset.runId;
      loadRunDetail(runId);
      switchView('current');
    });
  });
}

function renderRunDetail(run) {
  // Helper to combine and render logs for a specific phase
  function renderPhaseLogs(logs, phase) {
    const phaseLogs = logs.filter(l => l.phase === phase);
    if (phaseLogs.length === 0) return '';
    
    // Combine consecutive stdout entries for better markdown parsing
    const combined = [];
    let currentStdout = '';
    
    phaseLogs.forEach(entry => {
      if (entry.type === 'stdout') {
        currentStdout += entry.content;
      } else {
        if (currentStdout) {
          combined.push({ type: 'stdout', content: currentStdout, phase: entry.phase });
          currentStdout = '';
        }
        combined.push(entry);
      }
    });
    if (currentStdout) {
      combined.push({ type: 'stdout', content: currentStdout, phase });
    }
    
    return combined.map(entry => {
      if (entry.type === 'stdout') {
        return `<div class="log-entry ${entry.type} markdown-content">${simpleMarkdown(entry.content)}</div>`;
      } else if (entry.type === 'system') {
        return `<div class="log-entry ${entry.type}"><em>${escapeHtml(entry.content)}</em></div>`;
      } else {
        return `<div class="log-entry ${entry.type}">${escapeHtml(entry.content)}</div>`;
      }
    }).join('');
  }
  
  // Render logs by phase
  const promptLogsHtml = renderPhaseLogs(run.logs, 'prompt');
  const validationLogsHtml = renderPhaseLogs(run.logs, 'validation');
  const outputLogsHtml = renderPhaseLogs(run.logs, 'output');

  const imagesHtml = run.images.length ? 
    `<div class="images-grid">
      ${run.images.map(img => `
        <div class="image-item" data-src="/api/images/${run.id}/${img.filename}">
          <img src="/api/images/${run.id}/${img.filename}" alt="${escapeHtml(img.filename)}" loading="lazy">
        </div>
      `).join('')}
    </div>` : 
    '<p class="empty-state">No images generated</p>';

  const sessionHtml = run.sessionId ? 
    `<span class="run-session">Session: ${run.sessionId.slice(0, 8)}...</span>` : '';
  
  const continuedHtml = run.continueSession ?
    `<span>Continued from: ${run.continueSession.slice(0, 8)}...</span>` : '';

  runDetail.innerHTML = `
    <div class="run-detail-grid">
      <div class="detail-header">
        <h2>${escapeHtml(run.prompt.slice(0, 100))}${run.prompt.length > 100 ? '...' : ''}</h2>
        <div class="detail-meta">
          <span class="run-status ${run.status}">${run.status}</span>
          <span>${formatTime(run.createdAt)}</span>
          ${sessionHtml}
          ${continuedHtml}
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          Prompt Output
        </div>
        <div class="section-content">
          <div class="logs">${promptLogsHtml || '<p class="empty-state">No output yet</p>'}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          Validation
        </div>
        <div class="section-content">
          <div class="validation-status ${run.validation.status}">
            ${getValidationIcon(run.validation.status)}
            ${run.validation.status.toUpperCase()}
          </div>
          ${validationLogsHtml ? `<div class="logs" style="margin-top: 12px">${validationLogsHtml}</div>` : ''}
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          Image Generation Logs
        </div>
        <div class="section-content">
          <div class="logs">${outputLogsHtml || '<p class="empty-state">No output logs yet</p>'}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
          Generated Images
        </div>
        <div class="section-content">
          ${imagesHtml}
        </div>
      </div>

      ${run.status !== 'completed' && run.status !== 'failed' ? `
        <button class="btn btn-secondary" onclick="abortRun()">Abort Run</button>
      ` : ''}
    </div>
  `;

  // Add image click handlers
  runDetail.querySelectorAll('.image-item').forEach(item => {
    item.addEventListener('click', () => {
      openImageModal(item.dataset.src);
    });
  });
}

function getValidationIcon(status) {
  switch (status) {
    case 'passed': return '✅';
    case 'failed': return '❌';
    case 'running': return '⏳';
    case 'skipped': return '⏭️';
    default: return '⏸️';
  }
}

// Image Modal
function openImageModal(src) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <button class="modal-close" onclick="this.parentElement.remove()">×</button>
    <img src="${src}" alt="Image">
  `;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  document.body.appendChild(modal);
}

// Abort
async function abortRun() {
  if (!confirm('Are you sure you want to abort the current run?')) return;
  
  try {
    await fetch('/api/run/abort', { method: 'POST' });
    loadRunDetail(currentRunId);
  } catch (error) {
    console.error('Failed to abort:', error);
  }
}

// Notifications
function setupNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return;
  }

  if (Notification.permission === 'default') {
    notificationBanner.hidden = false;
  }

  document.getElementById('enableNotifications')?.addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await subscribeToPush();
    }
    notificationBanner.hidden = true;
  });

  document.getElementById('dismissNotifications')?.addEventListener('click', () => {
    notificationBanner.hidden = true;
  });

  // Register service worker
  if (Notification.permission === 'granted') {
    subscribeToPush();
  }
}

async function subscribeToPush() {
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    
    // Get VAPID key
    const res = await fetch('/api/push/vapid-key');
    const { publicKey } = await res.json();
    
    if (!publicKey) return;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    // Send subscription to server
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });

    console.log('Push subscription registered');
  } catch (error) {
    console.error('Push subscription failed:', error);
  }
}

// Utilities
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Simple markdown to HTML converter
function simpleMarkdown(text) {
  if (!text) return '';
  
  // Escape HTML first for security
  let html = escapeHtml(text);
  
  // Convert markdown patterns
  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  
  // Italic: *text* or _text_
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Headers: # ## ### etc
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  
  // Unordered lists: - item or * item
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  
  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.+<\/li>\n?)+/g, '<ul>$&</ul>');
  
  // Line breaks: double newline = paragraph break
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  
  // Wrap in paragraph if content exists
  if (html.trim()) {
    html = '<p>' + html + '</p>';
  }
  
  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>\s*<br>\s*<\/p>/g, '');
  
  return html;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Make abortRun available globally
window.abortRun = abortRun;
