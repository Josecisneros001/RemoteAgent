// State
let ws = null;
let config = null;
let sessions = [];
let currentSessionId = null;
let currentSession = null;
let currentRuns = [];
let currentRunId = null;

// Debounce timers
let runDetailDebounceTimer = null;
let sessionRunsDebounceTimer = null;
const DEBOUNCE_DELAY = 500; // ms

// DOM Elements
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const connectionStatus = document.getElementById('connectionStatus');
const connectionStatusDesktop = document.getElementById('connectionStatusDesktop');
const newSessionBtn = document.getElementById('newSessionBtn');
const quickStartBtn = document.getElementById('quickStartBtn');
const workspaceFilter = document.getElementById('workspaceFilter');
const sessionsList = document.getElementById('sessionsList');
const notificationBanner = document.getElementById('notificationBanner');

// Form Elements
const newSessionForm = document.getElementById('newSessionForm');
const workspaceSelect = document.getElementById('workspace');
const modelSelect = document.getElementById('model');
const promptInput = document.getElementById('prompt');
const validationPromptInput = document.getElementById('validationPrompt');
const outputPromptInput = document.getElementById('outputPrompt');
const startSessionBtn = document.getElementById('startSessionBtn');
const cancelNewSession = document.getElementById('cancelNewSession');

const newRunForm = document.getElementById('newRunForm');
const runPromptInput = document.getElementById('runPrompt');
const runModelSelect = document.getElementById('runModel');
const runValidationInput = document.getElementById('runValidation');
const runOutputInput = document.getElementById('runOutput');
const startRunBtn = document.getElementById('startRunBtn');

// Workspace Modal Elements
const workspaceModal = document.getElementById('workspaceModal');
const addWorkspaceBtn = document.getElementById('addWorkspaceBtn');
const closeWorkspaceModalBtn = document.getElementById('closeWorkspaceModal');
const cancelAddWorkspaceBtn = document.getElementById('cancelAddWorkspace');
const addWorkspaceForm = document.getElementById('addWorkspaceForm');

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupSidebar();
  setupWebSocket();
  await loadConfig();
  await loadSessions();
  setupForms();
  setupTabs();
  setupNotifications();
  setupWorkspaceModal();
}

// ==================== SIDEBAR ====================
function setupSidebar() {
  menuToggle?.addEventListener('click', toggleSidebar);
  sidebarOverlay?.addEventListener('click', closeSidebar);
  newSessionBtn?.addEventListener('click', showNewSessionForm);
  quickStartBtn?.addEventListener('click', showNewSessionForm);
  
  workspaceFilter?.addEventListener('change', () => {
    loadSessions(workspaceFilter.value || undefined);
  });
}

function toggleSidebar() {
  sidebar?.classList.toggle('open');
  sidebarOverlay?.classList.toggle('active');
  menuToggle?.classList.toggle('active');
}

function closeSidebar() {
  sidebar?.classList.remove('open');
  sidebarOverlay?.classList.remove('active');
  menuToggle?.classList.remove('active');
}

// ==================== WEBSOCKET ====================
function setupWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    updateConnectionStatus('connected');
  };

  ws.onclose = () => {
    updateConnectionStatus('disconnected');
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
  [connectionStatus, connectionStatusDesktop].forEach(el => {
    if (!el) return;
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('.status-text');
    
    if (dot) {
      dot.className = 'status-dot ' + status;
    }
    if (text) {
      text.textContent = status === 'connected' ? 'Connected' : 
                         status === 'disconnected' ? 'Disconnected' : 'Connecting...';
    }
  });
}

function handleWsEvent(event) {
  // Update current session/run view if applicable (debounced to prevent excessive API calls)
  if (event.sessionId === currentSessionId) {
    if (event.runId === currentRunId) {
      // Debounce run detail updates
      clearTimeout(runDetailDebounceTimer);
      runDetailDebounceTimer = setTimeout(() => {
        loadRunDetail(event.runId);
      }, DEBOUNCE_DELAY);
    } else {
      // Debounce session runs updates
      clearTimeout(sessionRunsDebounceTimer);
      sessionRunsDebounceTimer = setTimeout(() => {
        loadSessionRuns(currentSessionId);
      }, DEBOUNCE_DELAY);
    }
  }

  switch (event.type) {
    case 'complete':
      startSessionBtn.disabled = false;
      startSessionBtn.classList.remove('loading');
      startRunBtn.disabled = false;
      startRunBtn.classList.remove('loading');
      loadSessions();
      break;
    case 'phase':
      if (event.phase === 'prompt' && !currentRunId) {
        currentRunId = event.runId;
        currentSessionId = event.sessionId;
        loadSessionDetail(event.sessionId);
      }
      break;
  }
}

// ==================== API ====================
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    populateWorkspaces();
    populateModels();
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function loadSessions(workspaceId) {
  try {
    const url = workspaceId ? `/api/sessions?workspaceId=${workspaceId}` : '/api/sessions';
    const res = await fetch(url);
    const data = await res.json();
    sessions = data.sessions || [];
    renderSessionsList();
  } catch (error) {
    console.error('Failed to load sessions:', error);
    sessions = [];
    renderSessionsList();
  }
}

async function loadSessionDetail(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    const data = await res.json();
    if (data.session) {
      currentSessionId = sessionId;
      currentSession = data.session;
      currentRuns = data.runs || [];
      renderSessionDetail();
      switchView('session');
      closeSidebar();
      
      // Mark session as active in sidebar
      document.querySelectorAll('.session-item').forEach(item => {
        item.classList.toggle('active', item.dataset.sessionId === sessionId);
      });
    }
  } catch (error) {
    console.error('Failed to load session:', error);
  }
}

async function loadSessionRuns(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    const data = await res.json();
    if (data.runs) {
      currentRuns = data.runs;
      renderRunsTimeline();
    }
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
      switchView('run');
    }
  } catch (error) {
    console.error('Failed to load run:', error);
  }
}

async function loadGitChanges(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/git/changes`);
    const data = await res.json();
    renderGitChanges(data.changes);
  } catch (error) {
    console.error('Failed to load git changes:', error);
    renderGitChanges(null);
  }
}

// ==================== FORMS ====================
function setupForms() {
  newSessionForm?.addEventListener('submit', handleNewSession);
  cancelNewSession?.addEventListener('click', () => switchView('welcome'));
  newRunForm?.addEventListener('submit', handleNewRun);
  document.getElementById('backToSession')?.addEventListener('click', () => {
    if (currentSessionId) {
      loadSessionDetail(currentSessionId);
    }
  });
  
  // Load workspace defaults when workspace changes
  workspaceSelect?.addEventListener('change', loadWorkspaceDefaults);
}

function populateWorkspaces() {
  // Populate form select
  workspaceSelect.innerHTML = '<option value="">Select a workspace...</option>';
  
  // Populate filter select
  workspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
  
  if (!config?.workspaces?.length) return;

  config.workspaces.forEach(ws => {
    const option1 = document.createElement('option');
    option1.value = ws.id;
    option1.textContent = ws.name;
    workspaceSelect.appendChild(option1);
    
    const option2 = document.createElement('option');
    option2.value = ws.id;
    option2.textContent = ws.name;
    workspaceFilter.appendChild(option2);
  });
}

function populateModels() {
  const models = config?.availableModels || [];
  const defaultModel = config?.defaultModel || '';
  
  [modelSelect, runModelSelect].forEach(select => {
    if (!select) return;
    
    const isRunModel = select === runModelSelect;
    select.innerHTML = isRunModel 
      ? '<option value="">Use session default</option>'
      : `<option value="">Default (${defaultModel})</option>`;
    
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.appendChild(option);
    });
  });
}

function loadWorkspaceDefaults() {
  const wsId = workspaceSelect.value;
  const workspace = config?.workspaces?.find(w => w.id === wsId);
  if (!workspace) return;
  
  validationPromptInput.value = workspace.validationPrompt || '';
  outputPromptInput.value = workspace.outputPrompt || '';
}

async function handleNewSession(e) {
  e.preventDefault();
  
  const workspaceId = workspaceSelect.value;
  const prompt = promptInput.value.trim();
  
  if (!workspaceId || !prompt) {
    alert('Please select a workspace and enter a prompt');
    return;
  }

  startSessionBtn.disabled = true;
  startSessionBtn.classList.add('loading');

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        prompt,
        validationPrompt: validationPromptInput.value.trim() || undefined,
        outputPrompt: outputPromptInput.value.trim() || undefined,
        model: modelSelect.value || undefined,
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      alert(data.error);
      startSessionBtn.disabled = false;
      startSessionBtn.classList.remove('loading');
      return;
    }

    currentSessionId = data.sessionId;
    currentRunId = data.runId;
    
    // Clear form
    promptInput.value = '';
    
    // Load the new session
    loadSessionDetail(data.sessionId);
    loadSessions();

  } catch (error) {
    console.error('Failed to start session:', error);
    alert('Failed to start session');
    startSessionBtn.disabled = false;
    startSessionBtn.classList.remove('loading');
  }
}

async function handleNewRun(e) {
  e.preventDefault();
  
  if (!currentSessionId) {
    alert('No session selected');
    return;
  }
  
  const prompt = runPromptInput.value.trim();
  if (!prompt) {
    alert('Please enter a prompt');
    return;
  }

  startRunBtn.disabled = true;
  startRunBtn.classList.add('loading');

  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        prompt,
        validationPrompt: runValidationInput.value.trim() || undefined,
        outputPrompt: runOutputInput.value.trim() || undefined,
        model: runModelSelect.value || undefined,
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      alert(data.error);
      startRunBtn.disabled = false;
      startRunBtn.classList.remove('loading');
      return;
    }

    currentRunId = data.runId;
    
    // Clear form
    runPromptInput.value = '';
    runValidationInput.value = '';
    runOutputInput.value = '';
    
    // Switch to runs tab and refresh
    switchTab('runs');
    loadSessionRuns(currentSessionId);

  } catch (error) {
    console.error('Failed to start run:', error);
    alert('Failed to start run');
    startRunBtn.disabled = false;
    startRunBtn.classList.remove('loading');
  }
}

// ==================== TABS ====================
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('hidden', content.id !== `tab-${tabName}`);
  });

  // Load data for specific tabs
  if (tabName === 'changes' && currentSessionId) {
    loadGitChanges(currentSessionId);
  }
}

// ==================== VIEWS ====================
function switchView(viewName) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });
}

function showNewSessionForm() {
  switchView('new-session');
  closeSidebar();
}

// ==================== RENDERING ====================
function renderSessionsList() {
  if (!sessions.length) {
    sessionsList.innerHTML = '<p class="empty-state">No sessions yet</p>';
    return;
  }

  sessionsList.innerHTML = sessions.map(session => `
    <div class="session-item ${session.id === currentSessionId ? 'active' : ''}" data-session-id="${session.id}">
      <div class="session-item-name">${escapeHtml(session.friendlyName)}</div>
      <div class="session-item-branch">🌿 ${escapeHtml(session.branchName || 'no branch')}</div>
      <div class="session-item-meta">
        <span>${session.runCount} run${session.runCount !== 1 ? 's' : ''}</span>
        ${session.lastRunStatus ? `<span class="session-item-status ${session.lastRunStatus}">${session.lastRunStatus}</span>` : ''}
      </div>
    </div>
  `).join('');

  // Add click handlers
  sessionsList.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      loadSessionDetail(item.dataset.sessionId);
    });
  });
}

function renderSessionDetail() {
  if (!currentSession) return;
  
  document.getElementById('sessionName').textContent = currentSession.friendlyName;
  document.getElementById('sessionWorkspace').textContent = 
    config?.workspaces?.find(w => w.id === currentSession.workspaceId)?.name || currentSession.workspaceId;
  document.getElementById('sessionRunCount').textContent = `${currentRuns.length} run${currentRuns.length !== 1 ? 's' : ''}`;
  document.getElementById('sessionCreated').textContent = `Created: ${formatTime(currentSession.createdAt)}`;
  
  // Show branch name
  const branchEl = document.getElementById('sessionBranch');
  if (branchEl) {
    branchEl.textContent = `🌿 ${currentSession.branchName || 'no branch'}`;
  }
  
  // Pre-fill run form with session defaults
  if (currentSession.defaultValidationPrompt) {
    runValidationInput.value = currentSession.defaultValidationPrompt;
  }
  if (currentSession.defaultOutputPrompt) {
    runOutputInput.value = currentSession.defaultOutputPrompt;
  }
  
  renderRunsTimeline();
}

function renderRunsTimeline() {
  const container = document.getElementById('runsTimeline');
  
  if (!currentRuns.length) {
    container.innerHTML = '<p class="empty-state">No runs yet</p>';
    return;
  }

  // Reverse to show chronological order (oldest first, newest at bottom)
  const chronologicalRuns = [...currentRuns].reverse();
  
  container.innerHTML = chronologicalRuns.map((run, index) => {
    const commitHtml = run.commitInfo 
      ? `<div class="run-commit">
           <span class="commit-hash">${escapeHtml(run.commitInfo.shortHash)}</span>
           <span class="commit-stats">+${run.commitInfo.insertions}/-${run.commitInfo.deletions}</span>
         </div>`
      : '';
    
    return `
      <div class="run-timeline-item" data-run-id="${run.id}">
        <div class="run-number">#${index + 1}</div>
        <div class="run-info">
          <div class="run-prompt-preview">${escapeHtml(run.prompt)}</div>
          ${commitHtml}
          <div class="run-meta">
            <span class="run-status ${run.status}">${run.status}</span>
            <span>${formatTime(run.createdAt)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.run-timeline-item').forEach(item => {
    item.addEventListener('click', () => {
      loadRunDetail(item.dataset.runId);
    });
  });
}

function renderGitChanges(changes) {
  const container = document.getElementById('gitChanges');
  
  // Show commit history from runs instead of dirty changes
  const runsWithCommits = currentRuns.filter(r => r.commitInfo);
  
  if (runsWithCommits.length === 0) {
    // Fall back to showing current dirty state if no commits yet
    if (!changes || changes.branch === 'not a git repo') {
      container.innerHTML = '<p class="empty-state">Not a git repository</p>';
      return;
    }

    const hasStagedChanges = changes.staged?.length > 0;
    const hasUnstagedChanges = changes.unstaged?.length > 0;
    const hasUntrackedChanges = changes.untracked?.length > 0;
    const hasAnyChanges = hasStagedChanges || hasUnstagedChanges || hasUntrackedChanges;

    if (!hasAnyChanges) {
      container.innerHTML = `
        <div class="git-branch">
          Branch: <span class="git-branch-name">${escapeHtml(changes.branch)}</span>
        </div>
        <p class="empty-state">No changes yet - run a prompt to make changes</p>
      `;
      return;
    }

    // Show dirty changes (shouldn't happen normally since we commit after each run)
    let html = `
      <div class="git-branch">
        Branch: <span class="git-branch-name">${escapeHtml(changes.branch)}</span>
        <span class="uncommitted-badge">uncommitted</span>
      </div>
    `;

    if (hasStagedChanges) {
      html += renderGitSection('Staged Changes', changes.staged);
    }
    if (hasUnstagedChanges) {
      html += renderGitSection('Unstaged Changes', changes.unstaged);
    }
    if (hasUntrackedChanges) {
      html += renderGitSection('Untracked Files', changes.untracked);
    }

    container.innerHTML = html;
    return;
  }

  // Show commit history
  const branchName = currentSession?.branchName || changes?.branch || 'unknown';
  
  let html = `
    <div class="git-branch">
      Branch: <span class="git-branch-name">${escapeHtml(branchName)}</span>
      <span class="commits-count">${runsWithCommits.length} commit${runsWithCommits.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="commits-list">
  `;

  // Show commits in chronological order (oldest first)
  const sortedRuns = [...runsWithCommits].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  for (const run of sortedRuns) {
    const commit = run.commitInfo;
    html += `
      <div class="commit-item">
        <div class="commit-header">
          <span class="commit-hash">${escapeHtml(commit.shortHash)}</span>
          <span class="commit-date">${formatTime(commit.timestamp)}</span>
        </div>
        <div class="commit-message">${escapeHtml(commit.message)}</div>
        <div class="commit-stats">
          <span class="files-changed">${commit.filesChanged} file${commit.filesChanged !== 1 ? 's' : ''}</span>
          <span class="insertions">+${commit.insertions}</span>
          <span class="deletions">-${commit.deletions}</span>
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;
}

function renderGitSection(title, files) {
  return `
    <div class="git-section">
      <div class="git-section-header">
        <span>${title}</span>
        <span>${files.length} file${files.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="git-file-list">
        ${files.map(file => `
          <div class="git-file">
            <span>${escapeHtml(file.path)}</span>
            <span class="git-file-status ${file.status}">${file.status}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderRunDetail(run) {
  const container = document.getElementById('runContent');
  
  // Helper to combine and render logs for a specific phase
  function renderPhaseLogs(logs, phase) {
    const phaseLogs = logs.filter(l => l.phase === phase);
    if (phaseLogs.length === 0) return '';
    
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
  
  const promptLogsHtml = renderPhaseLogs(run.logs, 'prompt');
  const validationLogsHtml = renderPhaseLogs(run.logs, 'validation');
  const outputLogsHtml = renderPhaseLogs(run.logs, 'output');

  // Build commit info section
  const commitHtml = run.commitInfo ? `
    <div class="section">
      <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
        📦 Git Commit
      </div>
      <div class="section-content">
        <div class="commit-detail">
          <div class="commit-detail-header">
            <span class="commit-hash-large">${escapeHtml(run.commitInfo.shortHash)}</span>
            <span class="commit-branch">${escapeHtml(run.commitInfo.branch)}</span>
          </div>
          <div class="commit-message-large">${escapeHtml(run.commitInfo.message)}</div>
          <div class="commit-stats-detail">
            <span>${run.commitInfo.filesChanged} file${run.commitInfo.filesChanged !== 1 ? 's' : ''} changed</span>
            <span class="insertions">+${run.commitInfo.insertions} insertions</span>
            <span class="deletions">-${run.commitInfo.deletions} deletions</span>
          </div>
          <div class="commit-date">${formatTime(run.commitInfo.timestamp)}</div>
        </div>
      </div>
    </div>
  ` : '';

  const imagesHtml = run.images.length ? 
    `<div class="images-grid">
      ${run.images.map(img => `
        <div class="image-item" data-src="/api/images/${run.id}/${img.filename}">
          <img src="/api/images/${run.id}/${img.filename}" alt="${escapeHtml(img.filename)}" loading="lazy">
        </div>
      `).join('')}
    </div>` : 
    '<p class="empty-state">No images generated</p>';

  container.innerHTML = `
    <div class="detail-header">
      <h2>${escapeHtml(run.prompt)}</h2>
      <div class="detail-meta">
        <span class="run-status ${run.status}">${run.status}</span>
        <span>${formatTime(run.createdAt)}</span>
        ${run.model ? `<span>Model: ${escapeHtml(run.model)}</span>` : ''}
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

    ${commitHtml}

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
        Output Generation
      </div>
      <div class="section-content">
        <div class="logs">${outputLogsHtml || '<p class="empty-state">No output logs</p>'}</div>
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
  `;

  // Add image click handlers
  container.querySelectorAll('.image-item').forEach(item => {
    item.addEventListener('click', () => {
      openImageModal(item.dataset.src);
    });
  });
  
  // Auto-scroll logs to bottom if run is still in progress
  if (run.status !== 'completed' && run.status !== 'failed') {
    scrollLogsToBottom();
  }
}

// Scroll all log containers to bottom
function scrollLogsToBottom() {
  document.querySelectorAll('.logs').forEach(logsEl => {
    logsEl.scrollTop = logsEl.scrollHeight;
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

// ==================== IMAGE MODAL ====================
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

// ==================== ABORT ====================
async function abortRun() {
  if (!confirm('Are you sure you want to abort the current run?')) return;
  
  try {
    await fetch('/api/run/abort', { method: 'POST' });
    if (currentRunId) {
      loadRunDetail(currentRunId);
    }
  } catch (error) {
    console.error('Failed to abort:', error);
  }
}

// ==================== WORKSPACE MODAL ====================
function setupWorkspaceModal() {
  addWorkspaceBtn?.addEventListener('click', openWorkspaceModal);

  closeWorkspaceModalBtn?.addEventListener('click', closeWorkspaceModal);
  cancelAddWorkspaceBtn?.addEventListener('click', closeWorkspaceModal);

  // Close on backdrop click
  workspaceModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeWorkspaceModal);

  addWorkspaceForm?.addEventListener('submit', handleAddWorkspace);
}

function openWorkspaceModal() {
  // Populate model selects with actual default values
  const wsDefaultModel = document.getElementById('wsDefaultModel');
  const wsValidationModel = document.getElementById('wsValidationModel');
  const wsOutputModel = document.getElementById('wsOutputModel');
  
  const modelSelects = [
    { el: wsDefaultModel, defaultKey: 'defaultModel' },
    { el: wsValidationModel, defaultKey: 'defaultValidationModel' },
    { el: wsOutputModel, defaultKey: 'defaultOutputModel' },
  ];
  
  modelSelects.forEach(({ el, defaultKey }) => {
    if (el && config?.availableModels) {
      const globalDefault = config[defaultKey] || config.defaultModel;
      el.innerHTML = '';
      config.availableModels.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model === globalDefault ? `${model} (default)` : model;
        if (model === globalDefault) option.selected = true;
        el.appendChild(option);
      });
    }
  });
  
  workspaceModal.hidden = false;
}

function closeWorkspaceModal() {
  workspaceModal.hidden = true;
  addWorkspaceForm?.reset();
}

async function handleAddWorkspace(e) {
  e.preventDefault();

  const name = document.getElementById('workspaceName')?.value.trim();
  const path = document.getElementById('workspacePath')?.value.trim();
  const validationPrompt = document.getElementById('workspaceValidation')?.value.trim() || undefined;
  const outputPrompt = document.getElementById('workspaceOutput')?.value.trim() || undefined;
  const defaultModel = document.getElementById('wsDefaultModel')?.value || undefined;
  const validationModel = document.getElementById('wsValidationModel')?.value || undefined;
  const outputModel = document.getElementById('wsOutputModel')?.value || undefined;

  if (!name || !path) return;

  try {
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        name, 
        path, 
        validationPrompt, 
        outputPrompt,
        defaultModel,
        validationModel,
        outputModel,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      alert(error.error || 'Failed to add workspace');
      return;
    }

    // Reload config to get updated workspace list
    await loadConfig();
    closeWorkspaceModal();
    
    // Select the new workspace
    if (workspaceSelect) {
      workspaceSelect.value = path;
      loadWorkspaceDefaults();
    }
  } catch (error) {
    console.error('Failed to add workspace:', error);
    alert('Failed to add workspace');
  }
}

// ==================== NOTIFICATIONS ====================
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

  if (Notification.permission === 'granted') {
    subscribeToPush();
  }
}

async function subscribeToPush() {
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    
    const res = await fetch('/api/push/vapid-key');
    const { publicKey } = await res.json();
    
    if (!publicKey) return;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

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

// ==================== UTILITIES ====================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function simpleMarkdown(text) {
  if (!text) return '';
  
  let html = escapeHtml(text);
  
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.+<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  
  if (html.trim()) {
    html = '<p>' + html + '</p>';
  }
  
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
