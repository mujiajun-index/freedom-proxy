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
$('logFilter').addEventListener('submit', (e) => {
  e.preventDefault();
  loadLogs();
});

async function loadLogs() {
  const p = new URLSearchParams();
  const ip = $('f-ip').value.trim();
  if (ip) p.set('ip', ip);
  const pathVal = $('f-path').value.trim();
  if (pathVal) p.set('path', pathVal);
  const status = $('f-status').value.trim();
  if (status) p.set('status', status);
  const mapping = $('f-mapping').value.trim();
  if (mapping) p.set('mapping', mapping);
  p.set('limit', $('f-limit').value || '200');
  const qs = p.toString();
  $('exportLogsBtn').href = API + '/logs/export' + (qs ? '?' + qs : '');
  try {
    const d = await api('/logs' + (qs ? '?' + qs : ''));
    renderLogs(d.data.items || []);
  } catch (err) {
    $('logsBody').innerHTML = `<tr><td colspan="8" class="error">${esc(err.message)}</td></tr>`;
  }
}

function renderLogs(items) {
  const tb = $('logsBody');
  if (!items.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted">无匹配日志</td></tr>`;
    return;
  }
  tb.innerHTML = items
    .map((l) => {
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
      </tr>`;
    })
    .join('');
}

$('clearLogsBtn').addEventListener('click', async () => {
  if (!confirm('确认清空当前访问日志？（轮转产生的历史文件不受影响）')) return;
  try {
    await api('/logs', { method: 'DELETE' });
    toast('已清空');
    loadLogs();
  } catch (err) {
    toast(err.message);
  }
});

boot();
