// freedomProxy 管理后台前端逻辑
// 页面被托管在 /{token}/ 下，相对 API 路径基于当前 location 计算
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const API = BASE + 'api';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || 'HTTP ' + res.status);
  }
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

/* ---------- 会话与登录 ---------- */
function showLogin() {
  $('loginView').hidden = false;
  $('appView').hidden = true;
}
function showApp(user) {
  $('loginView').hidden = true;
  $('appView').hidden = false;
  $('userBadge').textContent = user ? '管理员：' + user : '';
  loadMappings();
}

async function boot() {
  try {
    const d = await api('/session');
    showApp(d.data.user);
  } catch {
    showLogin();
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').hidden = true;
  try {
    const d = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    showApp(d.data.user);
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').hidden = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  showLogin();
});

/* ---------- 标签页 ---------- */
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    const panel = $('tab-' + t.dataset.tab);
    panel.hidden = false;
    if (t.dataset.tab === 'whitelist') loadWhitelist();
  })
);

/* ---------- 代理映射 ---------- */
let mappings = [];

async function loadMappings() {
  try {
    const d = await api('/mappings');
    mappings = d.data || [];
    renderMappings();
  } catch (err) {
    $('mappingsBody').innerHTML = `<tr><td colspan="5" class="error">${esc(err.message)}</td></tr>`;
  }
}

function renderMappings() {
  const tb = $('mappingsBody');
  if (!mappings.length) {
    tb.innerHTML = `<tr><td colspan="5" class="muted">暂无映射，点击「新增映射」</td></tr>`;
    return;
  }
  tb.innerHTML = mappings
    .map(
      (m) => `
    <tr>
      <td><label class="switch"><input type="checkbox" class="toggle-enabled" data-id="${esc(m.id)}" ${m.enabled ? 'checked' : ''}><span class="slider"></span></label></td>
      <td class="path-cell">${esc(m.prefix)}</td>
      <td class="target-cell" title="${esc(m.target)}">${esc(m.target)}</td>
      <td>${esc(m.note || '')}</td>
      <td class="col-ops">
        <button class="btn btn-sm btn-ghost" data-act="test" data-id="${esc(m.id)}">测试</button>
        <button class="btn btn-sm btn-ghost" data-act="edit" data-id="${esc(m.id)}">编辑</button>
        <button class="btn btn-sm btn-danger" data-act="del" data-id="${esc(m.id)}">删除</button>
      </td>
    </tr>`
    )
    .join('');
}

$('mappingsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') {
    openModal(mappings.find((m) => m.id === id));
  } else if (act === 'del') {
    if (!confirm('确认删除该映射？')) return;
    try {
      await api('/mappings/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadMappings();
      toast('已删除');
    } catch (err) {
      toast(err.message);
    }
  } else if (act === 'test') {
    try {
      const d = await api('/test', { method: 'POST', body: JSON.stringify({ id }) });
      const r = d.data;
      toast(r.reachable ? `可达 · status=${r.status} · ${r.elapsedMs}ms` : `不可达：${r.error || ''}`);
    } catch (err) {
      toast(err.message);
    }
  }
});

$('mappingsBody').addEventListener('change', async (e) => {
  const cb = e.target.closest('input.toggle-enabled');
  if (!cb) return;
  const id = cb.dataset.id;
  try {
    await api('/mappings/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ enabled: cb.checked }),
    });
    toast('已' + (cb.checked ? '启用' : '禁用'));
  } catch (err) {
    toast(err.message);
    await loadMappings();
  }
});

/* ---------- 映射弹窗 ---------- */
function openModal(m) {
  $('modalTitle').textContent = m ? '编辑映射' : '新增映射';
  $('m-id').value = m ? m.id : '';
  $('m-prefix').value = m ? m.prefix : '';
  $('m-target').value = m ? m.target : '';
  $('m-note').value = m ? m.note || '' : '';
  $('m-enabled').checked = m ? m.enabled : true;
  $('modalError').hidden = true;
  $('modal').hidden = false;
}

$('addMappingBtn').addEventListener('click', () => openModal(null));
$('modalCancel').addEventListener('click', () => ($('modal').hidden = true));

$('mappingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('modalError').hidden = true;
  const payload = {
    prefix: $('m-prefix').value,
    target: $('m-target').value,
    note: $('m-note').value,
    enabled: $('m-enabled').checked,
  };
  try {
    const id = $('m-id').value;
    if (id) {
      await api('/mappings/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/mappings', { method: 'POST', body: JSON.stringify(payload) });
    }
    $('modal').hidden = true;
    await loadMappings();
    toast('已保存');
  } catch (err) {
    $('modalError').textContent = err.message;
    $('modalError').hidden = false;
  }
});

/* ---------- IP 白名单 ---------- */
async function loadWhitelist() {
  try {
    const d = await api('/whitelist');
    $('whitelistInput').value = d.data.ipWhitelist || '';
    $('whitelistMsg').textContent = '';
  } catch (err) {
    $('whitelistMsg').textContent = err.message;
  }
}

$('saveWhitelistBtn').addEventListener('click', async () => {
  $('whitelistMsg').textContent = '';
  try {
    await api('/whitelist', {
      method: 'PUT',
      body: JSON.stringify({ ipWhitelist: $('whitelistInput').value }),
    });
    $('whitelistMsg').textContent = '已保存';
    toast('白名单已保存');
  } catch (err) {
    $('whitelistMsg').textContent = err.message;
  }
});

/* ---------- 访问日志 ---------- */
let logPage = 1;
let logPageSize = 100;
let logPages = 1;
let logPageItems = [];

$('logFilter').addEventListener('submit', (e) => {
  e.preventDefault();
  logPage = 1;
  loadLogs();
});

function buildLogParams() {
  const p = new URLSearchParams();
  const ip = $('f-ip').value.trim();
  if (ip) p.set('ip', ip);
  const pathVal = $('f-path').value.trim();
  if (pathVal) p.set('path', pathVal);
  const status = $('f-status').value.trim();
  if (status) p.set('status', status);
  const mapping = $('f-mapping').value.trim();
  if (mapping) p.set('mapping', mapping);
  const startD = $('f-start').value;
  if (startD) p.set('start', startD + ' 00:00:00.000');
  const endD = $('f-end').value;
  if (endD) p.set('end', endD + ' 23:59:59.999');
  p.set('pageSize', String(logPageSize));
  p.set('page', String(logPage));
  return p;
}

async function loadLogs() {
  const qs = buildLogParams().toString();
  $('exportLogsBtn').href = API + '/logs/export' + (qs ? '?' + qs : '');
  try {
    const d = await api('/logs' + (qs ? '?' + qs : ''));
    const data = d.data || {};
    logPageItems = data.items || [];
    renderLogs(logPageItems);
    renderPager(data.total || 0, data.page || logPage, data.pageSize || 100);
  } catch (err) {
    $('logsBody').innerHTML = `<tr><td colspan="9" class="error">${esc(err.message)}</td></tr>`;
    $('logPager').innerHTML = '';
  }
}

function renderLogs(items) {
  const tb = $('logsBody');
  if (!items.length) {
    tb.innerHTML = `<tr><td colspan="9" class="muted">无匹配日志</td></tr>`;
    return;
  }
  tb.innerHTML = items
    .map((l, i) => {
      const cls = 'status-' + String(l.status).charAt(0);
      return `<tr>
        <td>${esc(l.time)}</td>
        <td>${esc(l.ip)}</td>
        <td>${esc(l.method)}</td>
        <td class="path-cell" title="${esc(l.path)}">${esc(l.path)}</td>
        <td class="${cls}">${l.status}</td>
        <td>${l.elapsedMs}</td>
        <td>${esc(l.mapping)}</td>
        <td class="target-cell" title="${esc(l.target)}">${esc(l.target)}</td>
        <td class="col-ops"><button class="btn btn-sm btn-ghost" data-detail="${i}">详情</button></td>
      </tr>`;
    })
    .join('');
}

$('logsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-detail]');
  if (!btn) return;
  const item = logPageItems[Number(btn.dataset.detail)];
  if (item) openLogDetail(item);
});

function openLogDetail(l) {
  const fields = [
    ['时间', l.time],
    ['IP', l.ip],
    ['方法', l.method],
    ['路径', l.path],
    ['状态码', l.status],
    ['耗时(ms)', l.elapsedMs],
    ['命中映射', l.mapping],
    ['转发目标', l.target],
    ['User-Agent', l.userAgent],
    ['响应字节', l.bytes],
  ];
  $('logDetailBody').innerHTML = fields
    .map(
      ([k, v]) =>
        `<div class="detail-row"><span class="detail-k">${esc(k)}</span><span class="detail-v">${esc(v)}</span></div>`
    )
    .join('');
  $('logDetailModal').hidden = false;
}
$('logDetailClose').addEventListener('click', () => ($('logDetailModal').hidden = true));

function pageList(current, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const list = [1];
  const left = Math.max(2, current - 2);
  const right = Math.min(pages - 1, current + 2);
  if (left > 2) list.push('…');
  for (let i = left; i <= right; i++) list.push(i);
  if (right < pages - 1) list.push('…');
  list.push(pages);
  return list;
}

function renderPager(total, page, pageSize) {
  const pager = $('logPager');
  logPages = Math.max(1, Math.ceil(total / pageSize));
  if (!total) {
    pager.innerHTML = '';
    return;
  }
  const sizeSet = Array.from(new Set([20, 50, 100, 200, 500, pageSize])).sort((a, b) => a - b);
  const sizeOptions = sizeSet
    .map((s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`)
    .join('');
  const nums = pageList(page, logPages)
    .map((n) =>
      n === '…'
        ? `<span class="pager-ellipsis">…</span>`
        : `<button class="pager-num ${n === page ? 'pager-active' : ''}" data-page="${n}">${n}</button>`
    )
    .join('');
  pager.innerHTML =
    `<span class="pager-total">共 ${total} 条</span>` +
    `<select class="pager-sizes" data-role="sizes">${sizeOptions}</select>` +
    `<div class="pager-nav">` +
    `<button class="pager-arrow" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button>` +
    nums +
    `<button class="pager-arrow" data-page="${page + 1}" ${page >= logPages ? 'disabled' : ''}>›</button>` +
    `</div>` +
    `<span class="pager-jumper">前往 <input type="number" class="pager-jumper-input" data-role="jumper" min="1" max="${logPages}" value="${page}"> 页</span>`;
}

$('logPager').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-page]');
  if (!b || b.disabled) return;
  logPage = Number(b.dataset.page) || 1;
  loadLogs();
});
$('logPager').addEventListener('change', (e) => {
  const role = e.target && e.target.dataset && e.target.dataset.role;
  if (role === 'sizes') {
    logPageSize = Math.min(1000, Math.max(1, Number(e.target.value) || 100));
    logPage = 1;
    loadLogs();
  } else if (role === 'jumper') {
    logPage = Math.min(Math.max(1, Number(e.target.value) || 1), logPages);
    loadLogs();
  }
});

$('clearLogsBtn').addEventListener('click', async () => {
  if (!confirm('确认清空当前访问日志？（轮转产生的历史文件不受影响）')) return;
  try {
    await api('/logs', { method: 'DELETE' });
    toast('已清空');
    logPage = 1;
    loadLogs();
  } catch (err) {
    toast(err.message);
  }
});

boot();
