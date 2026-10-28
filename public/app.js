const state = {
  overview: null,
  bots: [],
  orders: [],
  activity: [],
  filter: '',
  search: '',
  connected: false,
  refreshing: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const formatNumber = (value) => Number(value || 0).toLocaleString('en-US');
const formatMoney = (amount, currency = 'THB') => `${esc(currency.trim())} ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const niceStatus = (status) => String(status || 'unknown').replaceAll('_', ' ').toLowerCase();
const statusClass = (status) => String(status || 'offline').toLowerCase().replace(/[^a-z0-9_-]/g, '');
const ago = (value) => {
  if (!value) return 'Never seen';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return 'Unknown';
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
const fmtDate = (value) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const fmtUptime = (value) => {
  const seconds = Number(value || 0);
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
};
const notify = (title, message, kind = 'success') => {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.innerHTML = `<strong>${esc(title)}</strong><span>${esc(message)}</span>`;
  $('#toast-region').appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error;
    error.details = data.details;
    throw error;
  }
  return data;
}

async function refreshAll({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  if (!quiet) $('#refresh-btn').disabled = true;
  try {
    const [overview, bots, orders, activity] = await Promise.all([
      api('/api/overview'), api('/api/bots'), api('/api/orders?limit=50'), api('/api/activity?limit=8')
    ]);
    state.overview = overview;
    state.bots = bots.data || [];
    state.orders = orders.data || [];
    state.activity = activity.data || [];
    renderOverview();
    renderBots();
    renderOrders();
    renderActivity();
    renderDeploymentTargets();
    $('#updated-at').textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#connection-label').textContent = state.connected ? 'Live updates' : 'Polling mode';
  } catch (error) {
    $('#connection-label').textContent = 'API unavailable';
    if (!quiet) notify('Could not refresh dashboard', error.message, 'error');
  } finally {
    state.refreshing = false;
    $('#refresh-btn').disabled = false;
  }
}

function renderOverview() {
  const data = state.overview;
  if (!data) return;
  const b = data.bots || {};
  const o = data.orders || {};
  const online = Number(b.online || 0);
  const total = Number(b.total || 0);
  const active = Number(b.active || 0);
  const standby = Number(b.standby || 0);
  const progress = Number(o.in_progress || 0);
  const attention = Number(o.delayed || 0) + Number(o.failed || 0) + Number(b.error || 0);
  $('#stat-online').textContent = formatNumber(online);
  $('#stat-total').textContent = formatNumber(total);
  $('#stat-online-note').textContent = `${formatNumber(b.offline || 0)} offline · ${formatNumber(b.error || 0)} error`;
  $('#online-meter').style.width = `${total ? online / total * 100 : 0}%`;
  $('#stat-active').textContent = formatNumber(active);
  $('#stat-standby').textContent = `${formatNumber(standby)} on standby`;
  $('#active-meter').style.width = `${total ? active / total * 100 : 0}%`;
  $('#stat-progress').textContent = formatNumber(progress);
  $('#stat-queue').textContent = `${formatNumber(o.queued || 0)} queued · ${formatNumber(o.pending_payment || 0)} pending`;
  const totalOrders = Math.max(1, Number(o.total_orders || 0));
  $('#progress-meter').style.width = `${Math.min(100, progress / totalOrders * 100)}%`;
  $('#stat-attention').textContent = formatNumber(attention);
  $('#stat-attention-note').textContent = `${formatNumber(o.delayed || 0)} delayed · ${formatNumber(o.failed || 0)} failed`;
  $('#attention-meter').style.width = `${Math.min(100, attention / Math.max(1, total + totalOrders) * 100)}%`;
  $('#nav-bot-count').textContent = `${online}/${total}`;
  $('#bot-section-count').textContent = total;
  $('#order-section-count').textContent = o.total_orders || 0;
  const kill = data.killSwitch?.enabled;
  $('#kill-banner').classList.toggle('hidden', !kill);
  $('#kill-banner-off').textContent = 'Resume processing';
  const toggle = $('#kill-switch-toggle');
  toggle.textContent = kill ? 'Resume processing' : 'Pause new work';
  toggle.classList.toggle('button-danger-outline', Boolean(kill));
  toggle.classList.toggle('button-secondary', !kill);
  $('#new-order-btn').disabled = Boolean(kill);
  $('#new-order-btn').title = kill ? 'Disable the global kill-switch before accepting new orders' : 'Create test order';
}

function renderBots() {
  const root = $('#bot-grid');
  if (!state.bots.length) {
    root.innerHTML = '<div class="loading-card">No bot instances found. Check simulator connectivity and database seed data.</div>';
    return;
  }
  root.innerHTML = state.bots.map((bot) => {
    const online = bot.status === 'online';
    const lastHeartbeat = bot.last_heartbeat;
    const isStale = online && (!lastHeartbeat || Date.now() - new Date(lastHeartbeat).getTime() > 15000);
    const lastCommand = bot.latest_command ? `${bot.latest_command} · ${bot.latest_command_status || 'unknown'}` : 'No recent command';
    const cpu = Math.max(0, Math.min(100, Number(bot.cpu_percent || 0)));
    const memory = Math.max(0, Math.min(100, Number(bot.memory_percent || 0)));
    return `<article class="bot-card" data-bot-card="${esc(bot.id)}">
      <div class="bot-card-top"><div class="bot-identity"><div class="bot-avatar ${online ? '' : 'offline'}">▦</div><div style="min-width:0"><div class="bot-name">${esc(bot.name)}</div><div class="bot-device">${esc(bot.device_name || bot.id)}</div></div></div><span class="status-pill status-${statusClass(bot.status)}">${esc(bot.status)}</span></div>
      <div class="bot-heartbeat"><span>HEARTBEAT</span><span class="heartbeat-value ${isStale || !online ? 'stale' : ''}"><i class="tiny-dot"></i>${esc(online ? ago(lastHeartbeat) : 'No signal')}</span></div>
      <div class="resource-area"><div class="resource-row"><span class="resource-label">CPU</span><span class="resource-track"><i class="resource-fill" style="width:${cpu}%"></i></span><span class="resource-value">${cpu.toFixed(1)}%</span></div><div class="resource-row"><span class="resource-label">MEMORY</span><span class="resource-track"><i class="resource-fill memory" style="width:${memory}%"></i></span><span class="resource-value">${memory.toFixed(1)}%</span></div></div>
      <div class="bot-card-bottom"><div class="bot-last-job"><small>LAST COMMAND · UPTIME ${fmtUptime(bot.uptime_seconds)}</small><strong>${esc(lastCommand)}</strong></div><div class="bot-actions"><button class="small-action" data-bot-action="metrics" data-bot="${esc(bot.id)}" title="View metrics" aria-label="View metrics">⌁</button><button class="small-action" data-bot-action="logs" data-bot="${esc(bot.id)}" title="View logs" aria-label="View logs">≡</button>${online ? `<button class="small-action danger" data-bot-action="stop" data-bot="${esc(bot.id)}" title="Stop bot" aria-label="Stop bot">■</button>` : `<button class="small-action" data-bot-action="start" data-bot="${esc(bot.id)}" title="Start bot" aria-label="Start bot">▶</button>`}<button class="small-action" data-bot-action="restart" data-bot="${esc(bot.id)}" title="Restart bot" aria-label="Restart bot">↻</button></div></div>
    </article>`;
  }).join('');
}

const allowed = {
  PENDING_PAYMENT: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['IN_PROGRESS', 'DELAYED', 'FAILED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'DELAYED', 'FAILED'],
  DELAYED: ['QUEUED', 'IN_PROGRESS', 'FAILED', 'CANCELLED'],
  COMPLETED: [], FAILED: [], CANCELLED: []
};

function renderOrders() {
  const body = $('#orders-body');
  const q = state.search.toLowerCase();
  const list = state.orders.filter((order) => (!state.filter || order.status === state.filter) && (!q || String(order.external_order_id).toLowerCase().includes(q) || String(order.id).includes(q)));
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-cell">${state.orders.length ? 'No orders match this filter.' : 'No orders yet. Create a test order to get started.'}</td></tr>`;
  } else {
    body.innerHTML = list.map((order) => {
      const canDispatch = ['PENDING_PAYMENT', 'QUEUED', 'DELAYED'].includes(order.status);
      return `<tr><td><div class="order-id"><span class="order-glyph">⇄</span><span><strong>${esc(order.external_order_id)}</strong><small>ORD-${String(order.id).padStart(5, '0')}</small></span></div></td><td><span class="status-pill status-${statusClass(order.status)}">${esc(order.status.replaceAll('_', ' '))}</span></td><td><span class="amount-value">${formatMoney(order.amount, order.currency)}</span></td><td>${order.assigned_bot_id ? `<span class="bot-assignment"><i class="tiny-dot"></i>${esc(order.assigned_bot_id)}</span>` : '<span class="muted">Unassigned</span>'}</td><td><span class="time-value" title="${esc(fmtDate(order.last_event_at || order.updated_at))}">${esc(ago(order.last_event_at || order.updated_at))}</span></td><td class="align-right"><button class="order-action ${canDispatch ? '' : 'secondary'}" data-order-action="${canDispatch ? 'dispatch' : 'details'}" data-order="${esc(order.id)}">${canDispatch ? 'Dispatch →' : 'Details ↗'}</button></td></tr>`;
    }).join('');
  }
  $('#orders-footer').textContent = `Showing ${list.length} of ${state.orders.length} recent orders`;
}

function renderDeploymentTargets() {
  const root = $('#deploy-targets');
  const selected = new Set($$('input[name="targetBotIds"]', root).filter((input) => input.checked).map((input) => input.value));
  if (!state.bots.length) {
    root.innerHTML = '<span class="muted">No bots available.</span>';
    return;
  }
  root.innerHTML = state.bots.map((bot) => `<label class="target-check"><input type="checkbox" name="targetBotIds" value="${esc(bot.id)}" ${selected.has(bot.id) ? 'checked' : ''}/><span>${esc(bot.id)}</span></label>`).join('');
}

function activityInfo(entry) {
  const map = {
    'kill_switch.updated': ['!', 'amber-bg', `Kill-switch ${entry.metadata?.enabled ? 'enabled' : 'disabled'}`, entry.metadata?.reason || 'Global system control updated'],
    'bot.heartbeat_timeout': ['◌', 'red-bg', `Heartbeat timeout · ${entry.target_id}`, `${(entry.metadata?.delayedOrders || []).length} order(s) moved to delayed`],
    'order.created': ['＋', 'green-bg', 'Order created', entry.metadata?.externalOrderId || `Order ${entry.target_id}`],
    'order.dispatched': ['⇄', 'green-bg', 'Order dispatched', `${entry.target_id} → ${entry.metadata?.botId || 'bot'}`],
    'order.transition': ['⇢', '', 'Order state changed', `${entry.metadata?.from || '—'} → ${entry.metadata?.to || '—'}`],
    'deployment.requested': ['↥', '', 'Deployment staged', `${entry.metadata?.originalFilename || 'package.zip'} · ${(entry.metadata?.targetBotIds || []).length} target(s)`],
    'deployment.completed': ['✓', 'green-bg', 'Deployment rollout finished', `${entry.metadata?.status || 'unknown'} · ${entry.target_id}`]
  };
  if (map[entry.action]) return map[entry.action];
  const match = entry.action.match(/^bot\.command\.(.*)$/);
  if (match) return ['⌁', entry.action.endsWith('.failed') ? 'red-bg' : 'green-bg', `Bot command · ${match[1]}`, `${entry.target_id || 'unknown bot'} · ${entry.actor}`];
  return ['·', '', String(entry.action || 'System event').replaceAll('.', ' '), `${entry.target_type || 'system'}${entry.target_id ? ` · ${entry.target_id}` : ''}`];
}

function renderActivity() {
  const root = $('#activity-list');
  if (!state.activity.length) {
    root.innerHTML = '<div class="empty-state">No audit events have been recorded yet.</div>';
    return;
  }
  root.innerHTML = state.activity.slice(0, 7).map((entry) => {
    const [icon, className, title, detail] = activityInfo(entry);
    return `<div class="activity-item"><div class="activity-icon ${className}">${esc(icon)}</div><div class="activity-copy"><strong>${esc(title)}</strong><p>${esc(detail)}</p><time title="${esc(fmtDate(entry.created_at))}">${esc(ago(entry.created_at))} · ${esc(entry.actor || 'system')}</time></div></div>`;
  }).join('');
}

function showDialog(title, eyebrow, content) {
  $('#dialog-title').textContent = title;
  $('#dialog-eyebrow').textContent = eyebrow;
  $('#dialog-content').innerHTML = content;
  $('#detail-dialog').showModal();
}

async function showOrderDetails(id) {
  try {
    const { data, timeline, allowedTransitions } = await api(`/api/orders/${encodeURIComponent(id)}`);
    const timelineHtml = timeline.length ? timeline.map((event) => `<div class="timeline-item"><span class="timeline-node"></span><div><strong>${esc(event.event_type)}</strong><p>${esc(JSON.stringify(event.payload || {}))}</p><time>${esc(fmtDate(event.created_at))}</time></div></div>`).join('') : '<div class="empty-state">No timeline events.</div>';
    const transitionButtons = (allowedTransitions || []).map((next) => `<button class="mini-button" data-transition-order="${esc(data.id)}" data-next-status="${esc(next)}">Move to ${esc(next.replaceAll('_', ' '))}</button>`).join('');
    showDialog(data.external_order_id, `ORDER #${data.id} · TIMELINE`, `<div class="kv-grid"><div class="kv-item"><small>Current status</small><strong>${esc(data.status)}</strong></div><div class="kv-item"><small>Amount</small><strong>${formatMoney(data.amount, data.currency)}</strong></div><div class="kv-item"><small>Created</small><strong>${esc(fmtDate(data.created_at))}</strong></div><div class="kv-item"><small>Updated</small><strong>${esc(fmtDate(data.updated_at))}</strong></div></div><div class="dialog-subhead">EVENT TIMELINE</div><div class="timeline">${timelineHtml}</div><div class="inline-action-row">${transitionButtons}</div>`);
  } catch (error) { notify('Could not load order', error.message, 'error'); }
}

async function showBotMetrics(botId) {
  try {
    const { data } = await api(`/api/bots/${encodeURIComponent(botId)}/metrics`);
    showDialog(`${data.name} metrics`, 'BOT TELEMETRY', `<div class="kv-grid"><div class="kv-item"><small>Status</small><strong>${esc(data.status)}</strong></div><div class="kv-item"><small>Device</small><strong>${esc(data.device_name)}</strong></div><div class="kv-item"><small>CPU usage</small><strong>${Number(data.cpu_percent || 0).toFixed(1)}%</strong></div><div class="kv-item"><small>Memory usage</small><strong>${Number(data.memory_percent || 0).toFixed(1)}%</strong></div><div class="kv-item"><small>Uptime</small><strong>${esc(fmtUptime(data.uptime_seconds))}</strong></div><div class="kv-item"><small>Last heartbeat</small><strong>${esc(fmtDate(data.last_heartbeat))}</strong></div><div class="kv-item"><small>Dispatched total</small><strong>${formatNumber(data.dispatched_total)}</strong></div><div class="kv-item"><small>Active orders</small><strong>${formatNumber(data.active_orders)}</strong></div></div><div class="dialog-subhead">SOURCE</div><p class="section-caption">Metrics are polled from the supplied local bot simulator. They are not production telemetry.</p>`);
  } catch (error) { notify('Metrics unavailable', error.message, 'error'); }
}

async function showBotLogs(botId) {
  try {
    const data = await api(`/api/bots/${encodeURIComponent(botId)}/logs`);
    const content = `<div class="dialog-subhead">COMMAND HISTORY (${data.commands.length})</div>${data.commands.length ? data.commands.map((command) => `<div class="activity-item"><div class="activity-icon ${command.status === 'failed' ? 'red-bg' : 'green-bg'}">⌁</div><div class="activity-copy"><strong>${esc(command.command)} · ${esc(command.status)}</strong><p>Requested by ${esc(command.requested_by)} · command #${command.id}</p><time>${esc(fmtDate(command.created_at))}</time>${command.result ? `<pre class="log-json">${esc(JSON.stringify(command.result, null, 2))}</pre>` : ''}</div></div>`).join('') : '<div class="empty-state">No commands logged for this bot.</div>'}<div class="dialog-subhead">AUDIT EVENTS (${data.events.length})</div>${data.events.length ? data.events.map((event) => `<div class="activity-item"><div class="activity-icon">◷</div><div class="activity-copy"><strong>${esc(event.action)}</strong><p>${esc(JSON.stringify(event.metadata || {}))}</p><time>${esc(fmtDate(event.created_at))}</time></div></div>`).join('') : '<div class="empty-state">No audit events.</div>'}`;
    showDialog(`${botId} logs`, 'COMMANDS & AUDIT', content);
  } catch (error) { notify('Could not load logs', error.message, 'error'); }
}

async function runBotCommand(botId, command) {
  const kill = state.overview?.killSwitch?.enabled;
  if (kill && ['start', 'restart'].includes(command)) return notify('Kill-switch is enabled', 'Disable the global kill-switch before starting or restarting bots.', 'error');
  if (!window.confirm(`${command.toUpperCase()} ${botId}?`)) return;
  try {
    const response = await api(`/api/bots/${encodeURIComponent(botId)}/commands`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ command, requestedBy: 'dashboard' }) });
    notify('Bot command submitted', `${botId}: ${command} · ${response.command.status}`);
    await refreshAll({ quiet: true });
  } catch (error) { notify('Bot command failed', error.message, 'error'); }
}

async function setKillSwitch(enabled) {
  const promptText = enabled ? 'Pause new work across the entire bot fleet?' : 'Resume order processing across the bot fleet?';
  if (!window.confirm(promptText)) return;
  try {
    const response = await api('/api/control/kill-switch', { method: 'POST', body: JSON.stringify({ enabled, actor: 'dashboard', reason: enabled ? 'Operator enabled global kill-switch' : 'Operator resumed processing' }) });
    notify(enabled ? 'Kill-switch enabled' : 'Processing resumed', enabled ? 'New order processing and start/restart commands are blocked.' : 'The control plane will accept new work again.');
    await refreshAll({ quiet: true });
  } catch (error) { notify('Could not update global control', error.message, 'error'); }
}

function setFilter(status) {
  state.filter = status;
  $$('#order-filters .filter-tab').forEach((button) => button.classList.toggle('active', button.dataset.status === status));
  renderOrders();
}

function connectWebSocket() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try { socket = new WebSocket(`${scheme}//${location.host}/ws`); }
  catch { state.connected = false; return; }
  socket.addEventListener('open', () => {
    state.connected = true;
    $('#connection-label').textContent = 'Live updates';
  });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'refresh') refreshAll({ quiet: true });
    } catch { /* Ignore malformed transport messages. */ }
  });
  socket.addEventListener('close', () => {
    state.connected = false;
    $('#connection-label').textContent = 'Polling mode';
    setTimeout(connectWebSocket, 2500);
  });
  socket.addEventListener('error', () => socket.close());
}

$('#refresh-btn').addEventListener('click', () => refreshAll());
$('#activity-refresh').addEventListener('click', () => refreshAll());
$('#view-all-bots').addEventListener('click', () => { $('#bots').scrollIntoView({ behavior: 'smooth' }); });
$('#new-order-btn').addEventListener('click', () => $('#order-dialog').showModal());
$$('[data-close-order]').forEach((button) => button.addEventListener('click', () => $('#order-dialog').close()));
$('#dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#kill-banner-off').addEventListener('click', () => setKillSwitch(false));
$('#kill-switch-toggle').addEventListener('click', () => setKillSwitch(!state.overview?.killSwitch?.enabled));
$('#more-activity').addEventListener('click', async () => {
  try {
    const data = await api('/api/activity?limit=50');
    const content = data.data.length ? data.data.map((event) => {
      const [icon, klass, title, detail] = activityInfo(event);
      return `<div class="activity-item"><div class="activity-icon ${klass}">${esc(icon)}</div><div class="activity-copy"><strong>${esc(title)}</strong><p>${esc(detail)} · ${esc(JSON.stringify(event.metadata || {}))}</p><time>${esc(fmtDate(event.created_at))} · ${esc(event.actor)}</time></div></div>`;
    }).join('') : '<div class="empty-state">No activity logged.</div>';
    showDialog('Audit activity', 'RECENT SYSTEM EVENTS', content);
  } catch (error) { notify('Could not load activity', error.message, 'error'); }
});

$('#order-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-status]');
  if (button) setFilter(button.dataset.status);
});
$('#order-search').addEventListener('input', (event) => { state.search = event.target.value; renderOrders(); });
$('#bot-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-bot-action]');
  if (!button) return;
  const { bot, botAction } = button.dataset;
  if (botAction === 'metrics') showBotMetrics(bot);
  else if (botAction === 'logs') showBotLogs(bot);
  else runBotCommand(bot, botAction);
});
$('#orders-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-action]');
  if (!button) return;
  if (button.dataset.orderAction === 'dispatch') dispatchOrder(button.dataset.order);
  else showOrderDetails(button.dataset.order);
});
$('#dialog-content').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-transition-order]');
  if (!button) return;
  try {
    await api(`/api/orders/${encodeURIComponent(button.dataset.transitionOrder)}/transition`, { method: 'POST', body: JSON.stringify({ status: button.dataset.nextStatus, actor: 'dashboard' }) });
    notify('Order updated', `Moved order to ${button.dataset.nextStatus}.`);
    $('#detail-dialog').close();
    await refreshAll({ quiet: true });
  } catch (error) { notify('Invalid order transition', error.message, 'error'); }
});

async function dispatchOrder(id) {
  try {
    const response = await api(`/api/orders/${encodeURIComponent(id)}/dispatch`, { method: 'POST', body: JSON.stringify({ actor: 'dashboard' }) });
    notify('Order dispatched', `${response.order.external_order_id} → ${response.botId}`);
    await refreshAll({ quiet: true });
  } catch (error) { notify('Dispatch failed', error.message, 'error'); }
}

$('#order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  try {
    const result = await api('/api/orders', { method: 'POST', body: JSON.stringify({ ...body, amount: Number(body.amount), actor: 'dashboard' }) });
    $('#order-dialog').close();
    event.currentTarget.reset();
    notify(result.idempotentReplay ? 'Order already exists' : 'Test order created', `${result.data.external_order_id} · ${result.data.status}`);
    await refreshAll({ quiet: true });
  } catch (error) { notify('Could not create order', error.message, 'error'); }
});

$('#deploy-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  $('#upload-title').textContent = file ? file.name : 'Drop package here or browse';
});
const uploadZone = $('.upload-zone');
uploadZone.addEventListener('dragover', (event) => { event.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (event) => {
  event.preventDefault(); uploadZone.classList.remove('dragover');
  const file = event.dataTransfer.files?.[0];
  if (file && file.name.toLowerCase().endsWith('.zip')) {
    const input = $('#deploy-file');
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    $('#upload-title').textContent = file.name;
  } else notify('ZIP file required', 'Choose a .zip package.', 'error');
});
$('#select-all-bots').addEventListener('click', () => {
  const inputs = $$('input[name="targetBotIds"]');
  const shouldCheck = !inputs.every((input) => input.checked);
  inputs.forEach((input) => { input.checked = shouldCheck; });
  $('#select-all-bots').textContent = shouldCheck ? 'Clear all' : 'Select all';
});
$('#deploy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#deploy-file').files?.[0];
  const targets = $$('input[name="targetBotIds"]:checked').map((input) => input.value);
  if (!file) return notify('Choose a ZIP package', 'A package file is required.', 'error');
  if (!file.name.toLowerCase().endsWith('.zip')) return notify('Invalid file type', 'Only .zip packages are accepted.', 'error');
  if (file.size > 25 * 1024 * 1024) return notify('Package is too large', 'Maximum upload size is 25 MB.', 'error');
  if (!targets.length) return notify('Select target bots', 'Choose at least one bot instance for the rollout.', 'error');
  const button = $('#deploy-submit');
  button.disabled = true; button.innerHTML = '<span>◌</span> Staging package…';
  const data = new FormData(); data.append('package', file); data.append('targetBotIds', JSON.stringify(targets)); data.append('actor', 'dashboard');
  try {
    const result = await api('/api/deployments', { method: 'POST', body: data });
    const resultBox = $('#deployment-result');
    resultBox.classList.remove('hidden', 'error');
    resultBox.innerHTML = `<strong>${esc(result.status)}</strong><p>${esc(result.note)}</p><small>Deployment ${esc(result.deploymentId)} · ${result.rollout.length} target(s)</small>`;
    if (!result.ok) resultBox.classList.add('error');
    notify('Deployment request processed', `${result.status} · ${result.rollout.filter((item) => item.status === 'success').length}/${result.rollout.length} bot(s) restarted`, result.ok ? 'success' : 'error');
    await refreshAll({ quiet: true });
  } catch (error) { notify('Deployment failed', error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = '<span>↥</span> Stage &amp; roll out package'; }
});

refreshAll();
connectWebSocket();
setInterval(() => refreshAll({ quiet: true }), 10000);
