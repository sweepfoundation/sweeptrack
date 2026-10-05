'use strict';
const app = document.getElementById('app');
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the device's local time
const state = { mode: 'recent', date: today(), from: '', to: '', q: '', records: [], cursor: null };

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e; // text is always inserted as text nodes, never as HTML
}
let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), bad ? 6000 : 2500);
}
const fmtKg = (m) => { const f = String(m % 1000).padStart(3, '0').replace(/0+$/, ''); return Math.floor(m / 1000).toLocaleString('en-NG') + (f ? '.' + f : ''); };
const fmtNaira = (k) => 'â‚¦' + Math.floor(k / 100).toLocaleString('en-NG') + (k % 100 ? '.' + String(k % 100).padStart(2, '0') : '');
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtStamp = (s) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shiftDate = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const isPending = (r) => /pending/i.test(r);

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined,
      headers: { 'X-Requested-With': 'sweep', ...(body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch { throw new Error('Cannot reach the server. Nothing was changed.'); }
  if (res.status === 401 && path !== '/api/login') { showAuth(); throw new Error('Session expired. Please sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function pwField(input) {
  const btn = h('button', { type: 'button', class: 'eye', 'aria-label': 'Show password', onclick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  } }, 'Show');
  return h('div', { class: 'pw' }, input, btn);
}
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

function filterParams() {
  const p = new URLSearchParams();
  if (state.mode === 'day') { p.set('from', state.date); p.set('to', state.date); }
  else if (state.mode === 'range') { if (state.from) p.set('from', state.from); if (state.to) p.set('to', state.to); }
  if (state.q) p.set('q', state.q);
  return p;
}
function summaryParams() { // Recent view: totals for today, or for the search when one is typed
  if (state.mode === 'recent' && !state.q) { const t = today(); return new URLSearchParams({ from: t, to: t }); }
  return filterParams();
}
function scopeLabel() {
  if (state.mode === 'recent') return 'the latest records';
  if (state.mode === 'day') return fmtDate(state.date);
  if (state.mode === 'range') return `${state.from ? fmtDate(state.from) : 'start'} to ${state.to ? fmtDate(state.to) : 'latest'}`;
  return 'all dates';
}

// ---------- sign in, first time setup, password recovery ----------
const QUESTIONS = ["What is your mother's maiden name?", 'What was the name of your first school?', "What was your first pet's name?", 'In which town were you born?', 'What was your childhood nickname?'];
function questionPicker() {
  const sel = h('select', { 'aria-label': 'Security question' }, ...QUESTIONS.map((q) => h('option', { value: q }, q)), h('option', { value: '' }, 'Write my own question'));
  const own = h('input', { maxlength: 120, placeholder: 'Type your question', hidden: true });
  sel.addEventListener('change', () => { own.hidden = sel.value !== ''; if (!own.hidden) own.focus(); });
  return { node: h('div', {}, sel, own), get: () => (sel.value || own.value).trim() };
}
async function showAuth() {
  let setup = false;
  try { setup = (await (await fetch('/api/auth/status')).json()).setup_needed; } catch {}
  setup ? showSignup() : showLogin();
}
const authForm = (title, sub, onsubmit, ...kids) => h('form', { class: 'login', onsubmit },
  h('h1', {}, 'SweepTrack'), h('div', { class: 'hint' }, sub), h('h2', {}, title), ...kids);

function showLogin() {
  const err = h('div', { class: 'err' });
  const user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  app.replaceChildren(authForm('Sign in', 'Sweep Foundation Record', async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true, 'Signing in...');
    try { await api('/api/login', { method: 'POST', body: { username: user.value, password: pass.value } }); await showApp(); }
    catch (x) { err.textContent = x.message; busy(btn, false, 'Sign in'); }
  }, h('label', { for: 'u' }, 'Username'), user, h('label', { for: 'p' }, 'Password'), pwField(pass), err,
  h('div', { class: 'actions' }, btn),
  h('button', { type: 'button', class: 'link', onclick: showReset }, 'Forgot password?')));
}

function showSignup() {
  const err = h('div', { class: 'err' });
  const user = h('input', { autocomplete: 'username', autocapitalize: 'none', required: true, maxlength: 64 });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const qp = questionPicker(), ans = h('input', { type: 'password', autocomplete: 'off', required: true, maxlength: 100 });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Create account');
  app.replaceChildren(authForm('Create your account', 'Sweep Foundation Record. This first account is created once; sign up closes afterwards.', async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true, 'Creating...');
    try { await api('/api/signup', { method: 'POST', body: { username: user.value, password: pass.value, question: qp.get(), answer: ans.value } }); await showApp(); }
    catch (x) { err.textContent = x.message; busy(btn, false, 'Create account'); }
  }, h('label', {}, 'Username'), user, h('label', {}, 'Password (min 8 characters)'), pwField(pass),
  h('label', {}, 'Security question (used to reset your password)'), qp.node, h('label', {}, 'Answer'), pwField(ans), err,
  h('div', { class: 'actions' }, btn)));
}

function showReset() {
  const err = h('div', { class: 'err' }), box = h('div');
  const user = h('input', { autocomplete: 'username', autocapitalize: 'none', required: true, maxlength: 64 });
  const ans = h('input', { type: 'password', autocomplete: 'off', maxlength: 100 });
  const np = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Continue');
  let asked = false;
  app.replaceChildren(authForm('Reset password', 'Answer your security question to set a new password.', async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true);
    try {
      if (!asked) {
        const { question } = await api('/api/reset/question', { method: 'POST', body: { username: user.value } });
        asked = true; user.readOnly = true; ans.required = np.required = true;
        box.replaceChildren(h('label', {}, question), pwField(ans), h('label', {}, 'New password (min 8 characters)'), pwField(np));
        btn.textContent = 'Reset password'; ans.focus();
      } else {
        await api('/api/reset', { method: 'POST', body: { username: user.value, answer: ans.value, new_password: np.value } });
        showLogin(); toast('Password reset. Please sign in.'); return;
      }
    } catch (x) { err.textContent = x.message; }
    busy(btn, false);
  }, h('label', {}, 'Username'), user, box, err, h('div', { class: 'actions' }, btn),
  h('button', { type: 'button', class: 'link', onclick: showLogin }, 'Back to sign in')));
}

// ---------- dashboard ----------
let statsEl, listEl, moreEl, scopeEl, filtersEl;

async function showApp() {
  const search = h('input', { type: 'search', placeholder: 'Search customer name', value: state.q, 'aria-label': 'Search customer name' });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value.trim(); refresh(); }, 300); });
  statsEl = h('div', { class: 'stats' }); listEl = h('div'); moreEl = h('button', { onclick: () => loadList(true) }, 'Click to view more');
  scopeEl = h('div', { class: 'hint' }); filtersEl = h('div');
  app.replaceChildren(
    h('div', { class: 'bar' }, h('div', {}, h('h1', {}, 'SweepTrack'), h('div', { class: 'sub2' }, 'Sweep Foundation Record')), h('button', { class: 'fit', onclick: openSettings, 'aria-label': 'Settings' }, 'Settings')),
    h('div', { class: 'row tabs' }, ...[['recent', 'Recent'], ['day', 'Day'], ['range', 'Range'], ['all', 'All']].map(([m, l]) =>
      h('button', { class: state.mode === m ? 'on' : '', 'data-mode': m, onclick: () => { state.mode = m; renderFilters(); refresh(); } }, l))),
    filtersEl, statsEl,
    h('div', { class: 'row' }, search, h('button', { class: 'fit', onclick: () => exportCsv(filterParams()) }, 'Export CSV')),
    scopeEl, listEl, moreEl,
    h('button', { class: 'primary fab', onclick: () => openForm() }, '+ Add Record'));
  renderFilters(); await refresh();
}

function renderFilters() {
  document.querySelectorAll('.tabs button').forEach((b) => (b.className = b.dataset.mode === state.mode ? 'on' : ''));
  const date = (key, label) => h('div', {}, h('label', {}, label),
    h('input', { type: 'date', value: state[key], onchange: (e) => { state[key] = e.target.value; refresh(); } }));
  if (state.mode === 'day') {
    const input = h('input', { type: 'date', value: state.date, 'aria-label': 'Selected date', onchange: (e) => { if (e.target.value) { state.date = e.target.value; refresh(); } } });
    filtersEl.replaceChildren(h('div', { class: 'row' },
      h('button', { class: 'fit', 'aria-label': 'Previous day', onclick: () => { state.date = shiftDate(state.date, -1); input.value = state.date; refresh(); } }, 'â€¹'),
      input,
      h('button', { class: 'fit', 'aria-label': 'Next day', onclick: () => { state.date = shiftDate(state.date, 1); input.value = state.date; refresh(); } }, 'â€º')));
  } else if (state.mode === 'range') filtersEl.replaceChildren(h('div', { class: 'row' }, date('from', 'From'), date('to', 'To')));
  else filtersEl.replaceChildren();
}

async function refresh() {
  scopeEl.textContent = (state.q ? `Searching "${state.q}" in ` : 'Showing ') + scopeLabel();
  try {
    const [s] = await Promise.all([api('/api/summary?' + summaryParams()), loadList(false)]);
    const label = (state.mode === 'recent' && !state.q) || (state.mode === 'day' && state.date === today()) ? "Today's records" : 'Records';
    statsEl.replaceChildren(
      stat(label, s.count), stat('Total KG', fmtKg(s.kg_milli)), stat('Total amount', fmtNaira(s.amount_kobo)), stat('Pending', s.pending, 'pend'));
  } catch (e) { toast(e.message, true); }
}
const stat = (label, value, cls = '') => h('div', { class: 'stat ' + cls }, h('span', {}, label), h('b', {}, String(value)));

async function loadList(append) {
  const p = filterParams(); p.set('limit', '10');
  if (append && state.cursor) p.set('cursor', state.cursor);
  const data = await api('/api/records?' + p);
  state.records = append ? state.records.concat(data.records) : data.records;
  state.cursor = data.next_cursor;
  listEl.replaceChildren(...(state.records.length ? state.records.map(card) : [h('div', { class: 'empty' }, 'No records found.')]));
  moreEl.hidden = !state.cursor;
}
const card = (r) => h('button', { class: 'card', onclick: () => openDetail(r) },
  h('div', { class: 'top' }, h('span', {}, r.customer_name), h('span', {}, fmtNaira(r.amount_kobo))),
  h('div', { class: 'sub' }, `${fmtDate(r.date)}  Â·  ${fmtKg(r.kg_milli)} kg`),
  r.items.length ? h('div', { class: 'sub' }, r.items.map((i) => `${i.type} ${fmtKg(i.kg_milli)}`).join('  Â·  ')) : null,
  r.remark ? h('span', { class: 'pill' + (isPending(r.remark) ? ' pending' : '') }, r.remark) : null);

// ---------- dialogs ----------
function dialog(...kids) {
  const d = h('dialog', {}, ...kids);
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal(); return d;
}
const plain = (kobo) => `${Math.floor(kobo / 100)}${kobo % 100 ? '.' + String(kobo % 100).padStart(2, '0') : ''}`;
const plainKg = (m) => String(m / 1000);

function openDetail(r) {
  const d = dialog(
    h('h2', {}, r.customer_name),
    h('dl', {}, h('dt', {}, 'Date'), h('dd', {}, fmtDate(r.date)), h('dt', {}, 'Total KG'), h('dd', {}, fmtKg(r.kg_milli)),
      h('dt', {}, 'Plastic'), h('dd', {}, r.items.length ? r.items.map((i) => h('div', {}, `${i.type}: ${fmtKg(i.kg_milli)} kg`)) : '-'),
      h('dt', {}, 'Amount'), h('dd', {}, fmtNaira(r.amount_kobo)), h('dt', {}, 'Remark'), h('dd', {}, r.remark || '-'),
      h('dt', {}, 'Created'), h('dd', {}, fmtStamp(r.created_at)), h('dt', {}, 'Updated'), h('dd', {}, fmtStamp(r.updated_at))),
    h('div', { class: 'err', id: 'derr' }),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { d.close(); openForm(r); } }, 'Edit'),
      h('button', { class: 'danger', onclick: async (e) => {
        if (!confirm(`Delete the record for ${r.customer_name}? This cannot be undone.`)) return;
        busy(e.target, true);
        try { await api('/api/records/' + r.id, { method: 'DELETE' }); d.close(); toast('Record deleted'); refresh(); }
        catch (x) { d.querySelector('#derr').textContent = 'Not deleted: ' + x.message; busy(e.target, false); }
      } }, 'Delete'),
      h('button', { onclick: () => d.close() }, 'Close')));
}

const PLASTICS = ['PET', 'HDPE', 'PVC', 'LDPE', 'PP', 'PS', 'Other'];
const toMilli = (v) => { const t = String(v).trim().replace(/,/g, ''); if (!/^\d{1,9}(\.\d{1,3})?$/.test(t)) return null; const [i, f = ''] = t.split('.'); return Number(i) * 1000 + Number(f.padEnd(3, '0')); };

function openForm(r) {
  let clientId = crypto.randomUUID(); // reused on retry so a repeated submit cannot create a duplicate
  const date = h('input', { type: 'date', required: true, value: r ? r.date : (state.mode === 'day' ? state.date : today()) });
  const name = h('input', { required: true, maxlength: 120, autocomplete: 'off', value: r ? r.customer_name : '' });
  const amount = h('input', { required: true, inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: r ? plain(r.amount_kobo) : '' });
  const remark = h('input', { maxlength: 500, autocomplete: 'off', value: r ? r.remark : '' });
  const legacy = !!r && r.items.length === 0; // saved before plastic types existed: keeps its single KG until types are chosen
  const legacyKg = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: legacy ? plainKg(r.kg_milli) : '' });
  const inputs = new Map(); // type -> weight input, kept while toggling
  const chosen = new Set(r ? r.items.map((i) => i.type) : []);
  if (r) r.items.forEach((i) => inputs.set(i.type, h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': i.type + ' KG', value: plainKg(i.kg_milli) })));
  const chipsEl = h('div', { class: 'chips wrap' }), weightsEl = h('div'), totalEl = h('div', { class: 'total' });
  const err = h('div', { class: 'err' });

  function total() { let sum = 0; for (const t of chosen) sum += toMilli(inputs.get(t).value) || 0; return sum; }
  function paint() {
    chipsEl.replaceChildren(...PLASTICS.map((t) => h('button', { type: 'button', class: chosen.has(t) ? 'on' : '', 'aria-pressed': String(chosen.has(t)), onclick: () => {
      if (chosen.has(t)) chosen.delete(t); else { chosen.add(t); if (!inputs.has(t)) inputs.set(t, h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t + ' KG' })); }
      paint(); if (chosen.has(t)) inputs.get(t).focus();
    } }, t)));
    const rows = [...chosen].sort((a, b) => PLASTICS.indexOf(a) - PLASTICS.indexOf(b));
    weightsEl.replaceChildren(...rows.map((t) => h('div', { class: 'wrow' }, h('span', {}, t), inputs.get(t), h('em', {}, 'kg'))));
    if (rows.length) { totalEl.hidden = false; legacyBox.hidden = true; }
    else { totalEl.hidden = true; legacyBox.hidden = !legacy; }
    hint.hidden = rows.length > 0 || legacy;
    showTotal();
  }
  function showTotal() { totalEl.replaceChildren(h('span', {}, 'Total KG'), h('span', {}, fmtKg(total()))); }
  weightsEl.addEventListener('input', showTotal);
  const hint = h('div', { class: 'hint' }, 'Tap one or more plastic types, then enter the KG for each.');
  const legacyBox = h('div', { hidden: true }, h('label', {}, 'KG (no plastic type recorded)'), legacyKg);

  const btn = h('button', { class: 'primary', type: 'submit' }, r ? 'Save changes' : 'Save Record');
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const body = { date: date.value, customer_name: name.value, amount: amount.value, remark: remark.value, items: [] };
    if (chosen.size) {
      for (const t of PLASTICS.filter((x) => chosen.has(x))) {
        const m = toMilli(inputs.get(t).value);
        if (!m) { err.textContent = `Enter a KG amount above zero for ${t}.`; inputs.get(t).focus(); return; }
        body.items.push({ type: t, kg: inputs.get(t).value });
      }
    } else if (legacy) body.kg = legacyKg.value;
    else { err.textContent = 'Select at least one plastic type.'; return; }
    busy(btn, true, 'Saving...');
    try {
      if (r) await api('/api/records/' + r.id, { method: 'PUT', body });
      else await api('/api/records', { method: 'POST', body: { ...body, client_id: clientId } });
      d.close(); toast(r ? 'Record updated' : 'Record saved');
      if (state.mode === 'day' && date.value !== state.date) { state.date = date.value; renderFilters(); }
      refresh();
    } catch (x) { err.textContent = 'Record NOT saved: ' + x.message; busy(btn, false, r ? 'Save changes' : 'Save Record'); }
  } },
    h('h2', {}, r ? 'Edit Record' : 'New Record'),
    h('label', {}, 'Date'), date, h('label', {}, 'Customer name'), name,
    h('label', {}, 'Plastic type'), chipsEl, hint, weightsEl, totalEl, legacyBox,
    h('label', {}, 'Amount (â‚¦)'), amount,
    h('label', {}, 'Remark'), remark,
    h('div', { class: 'chips' }, ...['Paid', 'Pending', 'Collected'].map((t) => h('button', { type: 'button', onclick: () => (remark.value = t) }, t))),
    err, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
  paint();
  if (!r) name.focus();
}

function openSettings() {
  const info = h('dl'), err = h('div', { class: 'err' });
  api('/api/me').then((me) => info.replaceChildren(
    h('dt', {}, 'User'), h('dd', {}, me.username), h('dt', {}, 'Signed in'), h('dd', {}, fmtStamp(me.session_created)),
    h('dt', {}, 'Session ends'), h('dd', {}, fmtStamp(me.session_expires) + ' (extends with use)'))).catch(() => {});
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const pbtn = h('button', { type: 'submit' }, 'Change password');
  const qp = questionPicker(), serr = h('div', { class: 'err' }), sbtn = h('button', { type: 'submit' }, 'Save question');
  const sans = h('input', { type: 'password', autocomplete: 'off', required: true, maxlength: 100 });
  const spw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const d = dialog(
    h('h2', {}, 'Settings'), info,
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; busy(pbtn, true);
      try { await api('/api/password', { method: 'POST', body: { current_password: cur.value, new_password: nw.value } }); cur.value = nw.value = ''; toast('Password changed'); }
      catch (x) { err.textContent = x.message; }
      busy(pbtn, false);
    } }, h('label', {}, 'Current password'), pwField(cur), h('label', {}, 'New password (min 8 characters)'), pwField(nw), err, h('div', { class: 'actions' }, pbtn)),
    h('hr'), h('h2', {}, 'Security question'), h('div', { class: 'hint' }, 'Used to reset your password if you forget it.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); serr.textContent = ''; busy(sbtn, true);
      try { await api('/api/security', { method: 'POST', body: { current_password: spw.value, question: qp.get(), answer: sans.value } }); spw.value = sans.value = ''; toast('Security question saved'); }
      catch (x) { serr.textContent = x.message; }
      busy(sbtn, false);
    } }, h('label', {}, 'Question'), qp.node, h('label', {}, 'Answer'), pwField(sans), h('label', {}, 'Current password'), pwField(spw), serr, h('div', { class: 'actions' }, sbtn)),
    h('hr'),
    h('div', { class: 'actions' }, h('button', { onclick: () => exportCsv(new URLSearchParams()) }, 'Export all records')),
    h('hr'), h('div', { class: 'hint' }, 'SweepTrack v1.0. Records are saved only when the server confirms.'),
    h('div', { class: 'actions' },
      h('button', { class: 'danger', onclick: async () => { try { await api('/api/logout', { method: 'POST' }); } catch {} d.close(); showLogin(); } }, 'Log out'),
      h('button', { onclick: () => d.close() }, 'Close')));
}

async function exportCsv(params) {
  toast('Preparing CSV...');
  try {
    const res = await fetch('/api/export?' + params, { credentials: 'same-origin', headers: { 'X-Requested-With': 'sweep' } });
    if (res.status === 401) { showAuth(); throw new Error('Session expired. Please sign in again.'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Server error.');
    const blob = await res.blob(); // rejects if the stream was cut short, so a partial file is never presented as complete
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'sweep-records.csv';
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('CSV downloaded');
  } catch (e) { toast('CSV export failed: ' + e.message, true); }
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
api('/api/me').then(showApp).catch(() => { if (!document.querySelector('.login')) showAuth(); });
