'use strict';
const API_URL = 'https://sweeptrack-api.sweep-a4a.workers.dev';
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
const fmtNaira = (k) => '₦' + Math.floor(k / 100).toLocaleString('en-NG') + (k % 100 ? '.' + String(k % 100).padStart(2, '0') : '');
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtStamp = (s) => !s || isNaN(new Date(s)) ? '-' : new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shiftDate = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const isPending = (r) => /pending/i.test(r);

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API_URL + path, {
      method, credentials: 'include', body: body ? JSON.stringify(body) : undefined,
      headers: { 'X-Requested-With': 'sweep', ...(body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch { throw new Error('Cannot reach the server. Nothing was changed.'); }
  if (res.status === 401 && path !== '/api/login') { showAuth(); throw new Error('Session expired. Please sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Request failed.'); err.code = data.code; throw err; }
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

// ---------- clipboard ----------
// Modern clipboard API first; falls back to a hidden textarea and execCommand where the API is blocked or unavailable.
async function copyText(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return true; } } catch {}
  try {
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', class: 'clipfix' });
    ta.value = value;
    (document.querySelector('dialog[open]') || document.body).append(ta); // inside the open dialog, otherwise the page behind it is inert
    ta.select(); ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
function copyBtn(value, what) {
  const text = String(value == null ? '' : value).trim();
  const btn = h('button', { type: 'button', class: 'copy', 'aria-label': 'Copy ' + what, 'aria-live': 'polite' }, 'Copy');
  let timer;
  btn.addEventListener('click', async () => {
    const ok = await copyText(text);
    btn.textContent = ok ? 'Copied ✓' : text ? 'Copy failed' : 'Nothing to copy';
    btn.classList.toggle('ok', ok); btn.classList.toggle('bad', !ok);
    clearTimeout(timer); timer = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok', 'bad'); }, 1800);
  });
  return btn;
}
// a value with its copy button; an empty value shows a dash and no button
const copyRow = (value, what, node) => (value ? h('div', { class: 'copyrow' }, node || h('span', {}, value), copyBtn(value, what)) : '-');

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
  try { setup = (await (await fetch(API_URL + '/api/auth/status', { credentials: 'include' })).json()).setup_needed; } catch {}
  setup ? showSignup() : showLogin();
}
const authForm = (title, sub, onsubmit, ...kids) => h('form', { class: 'login', onsubmit },
  h('h1', {}, 'SweepTrack'), h('div', { class: 'hint' }, sub), h('h2', {}, title), ...kids);

function showLogin() {
  coopUnlocked = false; coopUi = null; logiUi = null; amountsShown = false;
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
let statsEl, listEl, moreEl, lessEl, scopeEl, filtersEl;

async function showApp(skipRoute) {
  if (!skipRoute && (location.hash === '#cooperative' || location.hash === '#logistics')) return route();
  const search = h('input', { type: 'search', placeholder: 'Search customer name', value: state.q, 'aria-label': 'Search customer name' });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value.trim(); refresh(); }, 300); });
  statsEl = h('div', { class: 'stats' }); listEl = h('div'); moreEl = h('button', { onclick: () => loadList(true) }, 'Click to view more');
  lessEl = h('button', { onclick: showLess, hidden: true }, 'Show less');
  scopeEl = h('div', { class: 'hint' }); filtersEl = h('div');
  app.replaceChildren(
    h('div', { class: 'bar' }, h('div', {}, h('h1', {}, 'SweepTrack'), h('div', { class: 'sub2' }, 'Sweep Foundation Record')), h('div', { class: 'barbtns' }, h('button', { class: 'fit', onclick: openGeneralCalc, 'aria-label': 'Open calculator' }, 'Calculator'), h('button', { class: 'fit', onclick: openSettings, 'aria-label': 'Settings' }, 'Settings'))),
    pageNav('records'),
    h('div', { class: 'row tabs' }, ...[['recent', 'Recent'], ['day', 'Day'], ['range', 'Range'], ['all', 'All']].map(([m, l]) =>
      h('button', { class: state.mode === m ? 'on' : '', 'data-mode': m, onclick: () => { state.mode = m; renderFilters(); refresh(); } }, l))),
    filtersEl, statsEl,
    h('div', { class: 'row' }, search, h('button', { class: 'fit', onclick: () => exportCsv(filterParams()) }, 'Export CSV')),
    scopeEl, listEl, h('div', { class: 'row more' }, moreEl, lessEl),
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
      h('button', { class: 'fit', 'aria-label': 'Previous day', onclick: () => { state.date = shiftDate(state.date, -1); input.value = state.date; refresh(); } }, '‹'),
      input,
      h('button', { class: 'fit', 'aria-label': 'Next day', onclick: () => { state.date = shiftDate(state.date, 1); input.value = state.date; refresh(); } }, '›')));
  } else if (state.mode === 'range') filtersEl.replaceChildren(h('div', { class: 'row' }, date('from', 'From'), date('to', 'To')));
  else filtersEl.replaceChildren();
}

async function refresh() {
  scopeEl.textContent = (state.q ? `Searching "${state.q}" in ` : 'Showing ') + scopeLabel();
  try {
    const [s] = await Promise.all([api('/api/summary?' + summaryParams()), loadList(false)]);
    const label = (state.mode === 'recent' && !state.q) || (state.mode === 'day' && state.date === today()) ? "Today's records" : 'Records';
    statsEl.replaceChildren(
      stat(label, num(s.count)), stat('Total KG', fmtKg(num(s.kg_milli))), stat('Total amount', fmtNaira(num(s.amount_kobo))), stat('Pending', num(s.pending), 'pend'));
  } catch (e) { toast(e.message, true); }
}
const stat = (label, value, cls = '') => h('div', { class: 'stat ' + cls }, h('span', {}, label), h('b', {}, String(value)));

const PAGE = 10;
// Older records (saved before plastic types existed) can come back without items, or with null fields.
// Normalising once here keeps every screen safe: card, detail, edit form, totals.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function normRecord(r) {
  const items = (Array.isArray(r.items) ? r.items : []).filter((i) => i && i.type).map((i) => ({ ...i, kg_milli: num(i.kg_milli), rate_kobo: i.rate_kobo == null ? null : num(i.rate_kobo) }));
  return { ...r, items, kg_milli: num(r.kg_milli), amount_kobo: num(r.amount_kobo), customer_name: r.customer_name || '', remark: r.remark || '', address: r.address || '', phone: r.phone || '', account_no: r.account_no || '', bank_name: r.bank_name || '' };
}
// Effective price per KG = amount paid / KG collected, in kobo. Null when it cannot be stated truthfully.
// one plastic type line: KG x price per KG in kobo, rounded to the nearest kobo (same exact maths as the server)
const lineKobo = (kgMilli, rateKobo) => Number((BigInt(kgMilli) * BigInt(rateKobo) + 500n) / 1000n);
const ratePerKg = (kgMilli, amountKobo) => (kgMilli > 0 && amountKobo > 0 ? Math.round(amountKobo * 1000 / kgMilli) : null);
const fmtRate = (kobo) => (kobo == null ? '-' : fmtNaira(kobo) + ' per KG');
async function loadList(append) {
  const p = filterParams(); p.set('limit', String(PAGE));
  if (append && state.cursor) p.set('cursor', state.cursor);
  const data = await api('/api/records?' + p);
  const incoming = (Array.isArray(data && data.records) ? data.records : []).filter((r) => r && typeof r === 'object').map(normRecord);
  state.records = append ? state.records.concat(incoming) : incoming;
  state.cursor = (data && data.next_cursor) || null;
  if (!append) state.firstCursor = state.cursor; // lets Show less return to the first page without refetching
  renderList();
}
function renderList() {
  listEl.replaceChildren(...(state.records.length ? state.records.map(card) : [h('div', { class: 'empty' }, 'No records found.')]));
  moreEl.hidden = !state.cursor;
  lessEl.hidden = state.records.length <= PAGE;
}
function showLess() {
  state.records = state.records.slice(0, PAGE); state.cursor = state.firstCursor;
  renderList(); listEl.scrollIntoView({ block: 'start' });
}
function cardRate(r) {
  if (r.items.length && r.items.every((i) => i.rate_kobo)) return ''; // each type shows its own price, so no overall price is needed
  const k = ratePerKg(r.kg_milli, r.amount_kobo);
  return k == null ? '' : (r.items.length > 1 ? 'Overall ' : '') + fmtNaira(k) + ' per KG';
}
const card = (r) => h('button', { class: 'card', onclick: () => openDetail(r) },
  h('div', { class: 'top' }, h('span', {}, r.customer_name), h('span', {}, fmtNaira(r.amount_kobo))),
  h('div', { class: 'sub' }, `${fmtDate(r.date)}  ·  ${fmtKg(r.kg_milli)} kg`),
  r.items.length ? h('div', { class: 'sub' }, r.items.map((i) => (i.rate_kobo ? `${i.type} ${fmtKg(i.kg_milli)} kg × ${fmtNaira(i.rate_kobo)}` : `${i.type} ${fmtKg(i.kg_milli)}`)).join('  ·  ')) : null,
  cardRate(r) ? h('div', { class: 'sub' }, cardRate(r)) : null,
  r.phone || r.address ? h('div', { class: 'sub clip' }, [r.phone, r.address].filter(Boolean).join('  ·  ')) : null,
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
    h('dl', {}, h('dt', {}, 'Date'), h('dd', {}, fmtDate(r.date)),
      h('dt', {}, 'Phone No'), h('dd', {}, copyRow(r.phone, 'Phone No', /^[+\d][\d\s().\-]*$/.test(r.phone) ? h('a', { href: 'tel:' + r.phone.replace(/[^\d+]/g, '') }, r.phone) : null)),
      h('dt', {}, 'Account No'), h('dd', {}, copyRow(r.account_no, 'Account No')),
      h('dt', {}, 'Bank Name'), h('dd', {}, r.bank_name || '-'),
      h('dt', {}, 'Address'), h('dd', {}, r.address || '-'), h('dt', {}, 'Total KG'), h('dd', {}, fmtKg(r.kg_milli)),
      h('dt', {}, 'Plastic'), h('dd', {}, r.items.length ? r.items.map((i) => h('div', {}, i.rate_kobo ? `${i.type}: ${fmtKg(i.kg_milli)} kg × ${fmtNaira(i.rate_kobo)} per KG = ${fmtNaira(lineKobo(i.kg_milli, i.rate_kobo))}` : `${i.type}: ${fmtKg(i.kg_milli)} kg`)) : '-'),
      h('dt', {}, 'Amount'), h('dd', {}, fmtNaira(r.amount_kobo)),
      ...(r.items.length && r.items.every((i) => i.rate_kobo) ? [] : [
      h('dt', {}, r.items.length > 1 ? 'Overall price' : 'Price'), h('dd', {}, fmtRate(ratePerKg(r.kg_milli, r.amount_kobo)) + (r.items.length > 1 ? ' (all types combined, not a rate per type)' : ''))]),
      h('dt', {}, 'Remark'), h('dd', {}, r.remark || '-'),
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
  const amount = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: r ? plain(r.amount_kobo) : '' });
  const amountLabel = h('label', {}, 'Amount (₦)');
  const remark = h('input', { maxlength: 500, autocomplete: 'off', value: r ? r.remark : '' });
  const phone = h('input', { type: 'tel', inputmode: 'tel', maxlength: 30, autocomplete: 'off', placeholder: 'Optional', value: r ? r.phone : '' });
  const account = h('input', { inputmode: 'numeric', maxlength: 30, autocomplete: 'off', placeholder: 'Optional', 'aria-label': 'Account No', value: r ? r.account_no : '' });
  const bank = h('input', { maxlength: 60, autocomplete: 'off', placeholder: 'Optional', 'aria-label': 'Bank Name', value: r ? r.bank_name : '' });
  const address = h('input', { maxlength: 300, autocomplete: 'off', placeholder: 'Optional', value: r ? r.address : '' });
  const legacy = !!r && r.items.length === 0; // saved before plastic types existed: keeps its single KG until types are chosen
  const hadRates = !!r && r.items.some((i) => i.rate_kobo != null); // a record that already has prices must keep a price for every type
  const legacyKg = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: legacy ? plainKg(r.kg_milli) : '' });
  // every plastic type has its own KG and its own price per KG
  const inputs = new Map(), rateIn = new Map(), rowNodes = new Map();
  const mkKg = (t, v = '') => h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t + ' KG', value: v });
  const mkRate = (t, v = '') => h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t + ' price per KG', value: v });
  const ensure = (t) => { if (!inputs.has(t)) { inputs.set(t, mkKg(t)); rateIn.set(t, mkRate(t)); } };
  const chosen = new Set(r ? r.items.map((i) => i.type) : []);
  if (r) r.items.forEach((i) => { inputs.set(i.type, mkKg(i.type, plainKg(i.kg_milli))); rateIn.set(i.type, mkRate(i.type, i.rate_kobo != null ? plain(i.rate_kobo) : '')); });
  const chipsEl = h('div', { class: 'chips wrap' }), weightsEl = h('div'), totalEl = h('div', { class: 'total' });
  const err = h('div', { class: 'err' }), rateEl = h('div', { class: 'hint rate' });
  const calcNote = h('div', { class: 'hint' });
  const panel = calcPanel({ onUse: ({ items }) => { // fill the record from the calculator result: types, KG and each type's price
    chosen.clear();
    items.forEach((i) => { chosen.add(i.type); ensure(i.type); inputs.get(i.type).value = i.kg; rateIn.get(i.type).value = i.rate; });
    paint();
    calcBox.hidden = true; calcToggle.setAttribute('aria-expanded', 'false'); calcToggle.textContent = 'Calculator';
    calcNote.textContent = 'Added from the calculator: plastic types, KG, price per KG and total. Complete the rest and save.';
  } });
  const calcBox = h('div', { class: 'calcbox', hidden: true }, panel.node);
  const calcToggle = h('button', { type: 'button', class: 'calctoggle', 'aria-expanded': 'false', onclick: () => {
    const open = calcBox.hidden; calcBox.hidden = !open; calcNote.textContent = '';
    calcToggle.setAttribute('aria-expanded', String(open)); calcToggle.textContent = open ? 'Hide calculator' : 'Calculator';
    if (open) panel.seed([...chosen].filter((t) => inputs.has(t)).map((t) => ({ type: t, kg: inputs.get(t).value, rate: rateIn.get(t).value })));
  } }, 'Calculator');

  const rateOf = (t) => { const k = toKobo(rateIn.get(t).value); return k && k > 0 ? k : null; };
  function rowNode(t) {
    if (!rowNodes.has(t)) {
      const amt = h('b', {}, '₦0');
      rowNodes.set(t, { amt, node: h('div', { class: 'crow' }, h('div', { class: 'top' }, h('span', {}, t), amt),
        h('div', { class: 'row' }, h('div', {}, h('label', {}, 'KG'), inputs.get(t)), h('div', {}, h('label', {}, 'Price per KG (₦)'), rateIn.get(t)))) });
    }
    return rowNodes.get(t);
  }
  function paint() {
    chipsEl.replaceChildren(...PLASTICS.map((t) => h('button', { type: 'button', class: chosen.has(t) ? 'on' : '', 'aria-pressed': String(chosen.has(t)), onclick: () => {
      if (chosen.has(t)) chosen.delete(t); else { chosen.add(t); ensure(t); }
      paint(); if (chosen.has(t)) inputs.get(t).focus();
    } }, t)));
    const rows = [...chosen].sort((a, b) => PLASTICS.indexOf(a) - PLASTICS.indexOf(b));
    weightsEl.replaceChildren(...rows.map((t) => rowNode(t).node));
    if (rows.length) { totalEl.hidden = false; legacyBox.hidden = true; }
    else { totalEl.hidden = true; legacyBox.hidden = !legacy; }
    hint.hidden = rows.length > 0 || legacy;
    showTotal();
  }
  function showTotal() {
    let kg = 0, sum = 0, all = chosen.size > 0;
    for (const t of chosen) {
      const m = toMilli(inputs.get(t).value) || 0, k = rateOf(t); kg += m;
      if (k) { const line = lineKobo(m, k); sum += line; rowNode(t).amt.textContent = fmtNaira(line); } else { all = false; rowNode(t).amt.textContent = '₦0'; }
    }
    totalEl.replaceChildren(h('span', {}, 'Total KG'), h('span', {}, fmtKg(kg)));
    amount.readOnly = all; amountLabel.textContent = all ? 'Total amount (₦)' : 'Amount (₦)';
    if (all) { amount.value = plain(sum); rateEl.textContent = 'Total = the sum of KG × price per KG for each plastic type.'; return; }
    const base = chosen.size ? kg : (legacy ? toMilli(legacyKg.value) || 0 : 0), k2 = ratePerKg(base, toKobo(amount.value) || 0); // no per type prices: show the overall price only
    rateEl.textContent = k2 == null ? 'Price per KG appears once KG and amount are entered.'
      : (chosen.size > 1 ? `Overall price: ${fmtNaira(k2)} per KG across all types (not a rate per type)` : `Price: ${fmtNaira(k2)} per KG`);
  }
  amount.addEventListener('input', showTotal); legacyKg.addEventListener('input', showTotal);
  weightsEl.addEventListener('input', showTotal);
  const hint = h('div', { class: 'hint' }, 'Tap one or more plastic types, then enter the KG and the price per KG for each.');
  const legacyBox = h('div', { hidden: true }, h('label', {}, 'KG (no plastic type recorded)'), legacyKg);

  const btn = h('button', { class: 'primary', type: 'submit' }, r ? 'Save changes' : 'Save Record');
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const body = { date: date.value, customer_name: name.value, phone: phone.value, account_no: account.value, bank_name: bank.value, address: address.value, amount: amount.value, remark: remark.value, items: [] };
    if (chosen.size) {
      for (const t of PLASTICS.filter((x) => chosen.has(x))) {
        const m = toMilli(inputs.get(t).value), rv = rateIn.get(t).value.trim();
        if (!m) { err.textContent = `Enter a KG amount above zero for ${t}.`; inputs.get(t).focus(); return; }
        if (rv === '' ? (!r || hadRates) : !rateOf(t)) { err.textContent = `Enter the price per KG for ${t}.`; rateIn.get(t).focus(); return; }
        body.items.push({ type: t, kg: inputs.get(t).value, ...(rv !== '' ? { rate: rv } : {}) });
      }
    } else if (legacy) body.kg = legacyKg.value;
    else { err.textContent = 'Select at least one plastic type.'; return; }
    if (!amount.readOnly && !amount.value.trim()) { err.textContent = 'Enter the amount.'; amount.focus(); return; }
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
    h('label', {}, 'Phone No'), phone, h('label', {}, 'Account No'), account, h('label', {}, 'Bank Name'), bank, h('label', {}, 'Address'), address,
    calcToggle, calcNote, calcBox,
    h('label', {}, 'Plastic type'), chipsEl, hint, weightsEl, totalEl, legacyBox,
    amountLabel, amount, rateEl,
    h('label', {}, 'Remark'), remark,
    h('div', { class: 'chips' }, ...['Paid', 'Pending', 'Collected'].map((t) => h('button', { type: 'button', onclick: () => (remark.value = t) }, t))),
    err, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
  paint();
  if (!r) name.focus();
}

// ---------- calculator: manual tool only, nothing here is ever saved as a record ----------
const toKobo = (v) => { const t = String(v).trim().replace(/,/g, ''); if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null; const [i, f = ''] = t.split('.'); return Number(i) * 100 + Number(f.padEnd(2, '0')); };
const RATES_KEY = 'sweeptrack-calc-rates'; // rates are remembered on this device only
function loadRates() {
  try { const o = JSON.parse(localStorage.getItem(RATES_KEY)) || {}; return Object.fromEntries(PLASTICS.filter((t) => typeof o[t] === 'string' && toKobo(o[t]) !== null).map((t) => [t, o[t]])); }
  catch { return {}; }
}
// The calculator as a reusable panel: used inside the Add/Edit Record form and in the standalone dialog.
// It never saves anything. When onUse is given, "Use in record" hands the result to the form.
function calcPanel({ onUse } = {}) {
  const rates = loadRates(), chosen = new Set(), rows = new Map();
  const chipsEl = h('div', { class: 'chips wrap' }), rowsEl = h('div');
  const kgTotal = h('span', {}, '0 kg'), amtTotal = h('span', {}, '₦0'), msg = h('div', { class: 'err' });
  const hint = h('div', { class: 'hint' }, 'Tap one or more plastic types, then enter the KG and the rate per KG.');
  const totals = h('div', { hidden: true }, h('div', { class: 'total' }, h('span', {}, 'Total KG'), kgTotal), h('div', { class: 'total' }, h('span', {}, 'Total amount'), amtTotal));

  function rowFor(t) {
    if (rows.has(t)) return rows.get(t);
    const kg = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Calculator ' + t + ' KG' });
    const rate = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Calculator ' + t + ' rate per KG', value: rates[t] || '' });
    const amt = h('b', {}, '₦0'), line = h('div', { class: 'sub' }, '');
    const node = h('div', { class: 'crow' },
      h('div', { class: 'top' }, h('span', {}, t), amt),
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'KG'), kg), h('div', {}, h('label', {}, 'Rate per KG (₦)'), rate)), line);
    rate.addEventListener('input', () => {
      const v = rate.value.trim();
      if (v === '') delete rates[t]; else if (toKobo(v) !== null) rates[t] = v;
      try { localStorage.setItem(RATES_KEY, JSON.stringify(rates)); } catch {}
    });
    const r = { kg, rate, amt, line, node };
    rows.set(t, r); return r;
  }
  function calc() {
    let kgSum = 0, amtSum = 0;
    for (const t of chosen) {
      const r = rows.get(t), mk = toMilli(r.kg.value), kk = toKobo(r.rate.value);
      r.kg.classList.toggle('bad', r.kg.value.trim() !== '' && mk === null);
      r.rate.classList.toggle('bad', r.rate.value.trim() !== '' && kk === null);
      const m = mk || 0, k = kk || 0, a = lineKobo(m, k);
      r.amt.textContent = fmtNaira(a);
      r.line.textContent = `${fmtKg(m)} kg × ${fmtNaira(k)} = ${fmtNaira(a)}`;
      kgSum += m; amtSum += a;
    }
    kgTotal.textContent = fmtKg(kgSum) + ' kg'; amtTotal.textContent = fmtNaira(amtSum);
  }
  function paint() {
    chipsEl.replaceChildren(...PLASTICS.map((t) => h('button', { type: 'button', class: chosen.has(t) ? 'on' : '', 'aria-pressed': String(chosen.has(t)), onclick: () => {
      if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
      msg.textContent = ''; paint(); if (chosen.has(t)) rowFor(t).kg.focus();
    } }, t)));
    rowsEl.replaceChildren(...PLASTICS.filter((t) => chosen.has(t)).map((t) => rowFor(t).node));
    hint.hidden = chosen.size > 0; totals.hidden = chosen.size === 0;
    calc();
  }
  function reset() { // clears weights and selections; saved rates stay so the next calculation starts quickly
    chosen.clear(); rows.forEach((r) => { r.kg.value = ''; }); msg.textContent = ''; paint();
  }
  function seed(list) { // carries the types and KG already typed in the record into an empty calculator
    if (chosen.size || !list.length) return;
    list.forEach((i) => { chosen.add(i.type); const r = rowFor(i.type); r.kg.value = i.kg; if (i.rate) r.rate.value = i.rate; }); paint();
  }
  function use() {
    msg.textContent = '';
    if (!chosen.size) { msg.textContent = 'Select a plastic type first.'; return; }
    const items = []; let amountKobo = 0;
    for (const t of PLASTICS.filter((x) => chosen.has(x))) {
      const r = rows.get(t), m = toMilli(r.kg.value), k = toKobo(r.rate.value);
      if (!m) { msg.textContent = `Enter a KG amount above zero for ${t}.`; r.kg.focus(); return; }
      if (!k) { msg.textContent = `Enter a rate per KG for ${t}.`; r.rate.focus(); return; }
      items.push({ type: t, kg: plainKg(m), rate: plain(k) }); amountKobo += lineKobo(m, k);
    }
    onUse({ items, amountKobo });
  }
  rowsEl.addEventListener('input', () => { msg.textContent = ''; calc(); });
  const node = h('div', {}, chipsEl, hint, rowsEl, totals, msg,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: reset }, 'Reset'), onUse ? h('button', { type: 'button', class: 'primary', onclick: use }, 'Use in record') : null));
  // Enter inside the calculator must never submit the record form it sits in
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
  paint();
  return { node, seed, reset };
}
// ---------- General calculator: standalone, completely separate from the collection calculator ----------
// Supports + − × ÷ % ( ) √ and squaring without eval. Percent follows the usual calculator rule: 200 + 10% = 220, 200 × 10% = 20.
function calcEval(src) {
  const tokens = [];
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) { tokens.push({ n: parseFloat(num[0]) }); i += num[0].length; continue; }
    if (src.startsWith('sqrt', i)) { tokens.push({ f: 'sqrt' }); i += 4; continue; }
    if ('+-*/()%²'.includes(ch)) { tokens.push({ o: ch }); i++; continue; }
    throw new Error('syntax');
  }
  let p = 0;
  const is = (t, c) => !!t && t.o === c;
  function expr() {
    let l = term();
    while (is(tokens[p], '+') || is(tokens[p], '-')) {
      const op = tokens[p++].o, r = term(), rv = r.pct ? l.v * r.v : r.v; // "a + b%" means a + (a × b / 100)
      l = { v: op === '+' ? l.v + rv : l.v - rv, pct: false };
    }
    return l;
  }
  function term() {
    let l = unary();
    while (is(tokens[p], '*') || is(tokens[p], '/')) {
      const op = tokens[p++].o, r = unary();
      if (op === '/' && r.v === 0) throw new Error('div0');
      l = { v: op === '*' ? l.v * r.v : l.v / r.v, pct: false };
    }
    return l;
  }
  function unary() {
    if (is(tokens[p], '-')) { p++; const x = unary(); return { v: -x.v, pct: x.pct }; }
    if (is(tokens[p], '+')) { p++; return unary(); }
    let x = primary();
    while (is(tokens[p], '%') || is(tokens[p], '²')) { const op = tokens[p++].o; x = op === '%' ? { v: x.v / 100, pct: true } : { v: x.v * x.v, pct: false }; }
    return x;
  }
  function primary() {
    const t = tokens[p++];
    if (!t) throw new Error('syntax');
    if (t.n !== undefined) return { v: t.n, pct: false };
    if (t.f === 'sqrt') {
      if (!is(tokens[p++], '(')) throw new Error('syntax');
      const x = expr(); if (!is(tokens[p++], ')')) throw new Error('syntax');
      if (x.v < 0) throw new Error('domain');
      return { v: Math.sqrt(x.v), pct: false };
    }
    if (is(t, '(')) { const x = expr(); if (!is(tokens[p++], ')')) throw new Error('syntax'); return { v: x.v, pct: false }; }
    throw new Error('syntax');
  }
  const r = expr();
  if (p < tokens.length) throw new Error('syntax');
  if (!Number.isFinite(r.v)) throw new Error('overflow');
  return r.v;
}
function fmtCalc(n) {
  n = Number(n.toPrecision(12)); // hides float noise such as 0.1 + 0.2
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e15 || a < 1e-9) return n.toExponential(6).replace(/\.?0+e/, 'e');
  return n.toLocaleString('en-NG', { maximumFractionDigits: 10 });
}
const calcPlain = (n) => Number(n.toPrecision(12)).toFixed(12).replace(/\.?0+$/, '') || '0';
function openGeneralCalc() {
  let expr = '', done = false, error = '';
  const exprEl = h('div', { class: 'gexpr' }), resEl = h('div', { class: 'gres', role: 'status', 'aria-live': 'polite' }, '0');
  const last = () => expr.slice(-1), isOperand = (c) => /[0-9)%²]/.test(c), curNum = () => (/(\d*\.?\d*)$/.exec(expr) || [''])[0];
  const pretty = (e) => e.replace(/\d+(\.\d*)?/g, (m) => { const [i, f] = m.split('.'); return Number(i).toLocaleString('en-NG') + (f !== undefined ? '.' + f : ''); })
    .replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−').replace(/sqrt\(/g, '√(').replace(/([0-9)%²])([+−×÷])/g, '$1 $2 ');
  const closed = (e) => e.replace(/[-+*/]+$/, '') + ')'.repeat(Math.max(0, (e.match(/\(/g) || []).length - (e.match(/\)/g) || []).length));
  const ERR = { div0: 'Cannot divide by zero', domain: 'Invalid input', overflow: 'Number too large' };
  function paint() {
    exprEl.textContent = done ? pretty(expr) : pretty(expr);
    let text = '0';
    if (error) text = error;
    else if (done) text = fmtCalc(Number(expr));
    else if (expr) { try { text = fmtCalc(calcEval(closed(expr))); } catch { text = resEl.dataset.last || '0'; } }
    resEl.dataset.last = error ? '' : text; resEl.textContent = text; resEl.classList.toggle('bad', !!error); resEl.classList.toggle('sm', text.length > 11);
  }
  function equals() {
    if (!expr || done) return;
    const src = closed(expr);
    try { const v = calcEval(src); exprEl.dataset.line = pretty(src) + ' ='; expr = calcPlain(v); done = true; error = ''; }
    catch (e) { error = ERR[e.message] || 'Error'; }
    paint(); if (done) exprEl.textContent = exprEl.dataset.line;
  }
  function press(k) {
    error = '';
    if (k === 'clear') { expr = ''; done = false; return paint(); }
    if (k === '=') return equals();
    if (done) { // after "=": operators continue from the result, other keys start a new calculation
      done = false;
      if (!['+', '-', '*', '/', '%', 'sq', 'neg'].includes(k) && k !== 'back') expr = '';
      if (k === 'back') { expr = ''; return paint(); }
    }
    if (/^[0-9]$/.test(k)) {
      if (isOperand(last()) && last() !== '') { if (!/[0-9]/.test(last())) expr += '*'; }
      const n = curNum();
      if (n.replace('.', '').length >= 15) return paint();
      if (n === '0') { if (k !== '0') expr = expr.slice(0, -1) + k; } else expr += k;
    } else if (k === '.') {
      const n = curNum();
      if (n.includes('.')) return paint();
      if (n === '') { if (/[)%²]/.test(last())) expr += '*'; expr += '0.'; } else expr += '.';
    } else if ('+-*/'.includes(k)) {
      if (expr === '' || last() === '(') { if (k === '-') expr += '-'; }
      else if (k === '-' && /[*/]/.test(last())) expr += '-';
      else expr = expr.replace(/[-+*/]+$/, '') + k;
    } else if (k === '%' || k === 'sq') { if (isOperand(last())) expr += k === '%' ? '%' : '²'; }
    else if (k === '(') { if (isOperand(last())) expr += '*'; expr += '('; }
    else if (k === ')') { const open = (expr.match(/\(/g) || []).length - (expr.match(/\)/g) || []).length; if (open > 0 && isOperand(last())) expr += ')'; }
    else if (k === 'sqrt') { if (isOperand(last())) expr += '*'; expr += 'sqrt('; }
    else if (k === 'neg') {
      if (/^-\d+\.?\d*$/.test(expr)) expr = expr.slice(1);
      else if (/\(-\d+\.?\d*\)$/.test(expr)) expr = expr.replace(/\(-(\d+\.?\d*)\)$/, '$1');
      else if (/\d$/.test(expr)) expr = expr.replace(/(\d+\.?\d*)$/, '(-$1)');
    } else if (k === 'back') expr = expr.endsWith('sqrt(') ? expr.slice(0, -5) : expr.slice(0, -1);
    paint();
  }
  const key = (label, k, cls, aria) => h('button', { type: 'button', class: 'gk ' + (cls || ''), 'aria-label': aria || label, onclick: () => press(k) }, label);
  const keys = h('div', { class: 'gkeys' },
    key('(', '(', 'gfn', 'Open bracket'), key(')', ')', 'gfn', 'Close bracket'), key('√', 'sqrt', 'gfn', 'Square root'), key('x²', 'sq', 'gfn', 'Square'),
    key('AC', 'clear', 'gfn', 'Clear all'), key('⌫', 'back', 'gfn', 'Backspace'), key('%', '%', 'gfn', 'Percent'), key('÷', '/', 'gop', 'Divide'),
    key('7', '7'), key('8', '8'), key('9', '9'), key('×', '*', 'gop', 'Multiply'),
    key('4', '4'), key('5', '5'), key('6', '6'), key('−', '-', 'gop', 'Subtract'),
    key('1', '1'), key('2', '2'), key('3', '3'), key('+', '+', 'gop', 'Add'),
    key('±', 'neg', 'gfn', 'Plus or minus'), key('0', '0'), key('.', '.', '', 'Decimal point'), key('=', '=', 'geq', 'Equals'));
  const d = dialog(h('h2', {}, 'Calculator'), h('div', { class: 'gdisp' }, exprEl, resEl), keys,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Close')));
  d.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const m = { Enter: '=', '=': '=', Backspace: 'back', Delete: 'clear', c: 'clear', C: 'clear', ',': '.', '.': '.', '+': '+', '-': '-', '*': '*', x: '*', X: '*', '/': '/', '%': '%', '(': '(', ')': ')' };
    const k = /^[0-9]$/.test(e.key) ? e.key : m[e.key];
    if (k) { e.preventDefault(); press(k); }
  });
  paint();
}

// ---------- Waste Recyclers Cooperative (separate from customer collection records) ----------
const BANK = { name: 'Sterling Bank', no: '0088343203' };
const coop = { members: [], totals: null, adjustments: [], tx: [], hasMore: false, limit: 20, filter: '' };
let coopUi = null, bankShown = false, coopUnlocked = false, logiUi = null;
// Financial amounts are hidden by default and hidden again every time the Cooperative or Logistics page is opened.
let amountsShown = false;
const MASK = '₦ ••••';
const money = (kobo) => (amountsShown ? fmtNaira(kobo) : MASK);
const safeMsg = (m) => (amountsShown ? String(m) : String(m).replace(/₦[\d,]+(\.\d+)?/g, MASK)); // messages from the server can contain amounts
function amountsBar(rerender) {
  const label = h('span', {}), btn = h('button', { type: 'button', class: 'fit' });
  const paint = () => { label.textContent = amountsShown ? 'Amounts are showing' : 'Amounts are hidden'; btn.textContent = amountsShown ? 'Hide amounts' : 'Show amounts'; btn.setAttribute('aria-pressed', String(amountsShown)); };
  btn.addEventListener('click', () => { amountsShown = !amountsShown; paint(); rerender(); });
  paint(); return h('div', { class: 'amtbar' }, label, btn);
}
const topBar = () => h('div', { class: 'bar' }, h('div', {}, h('h1', {}, 'SweepTrack'), h('div', { class: 'sub2' }, 'Sweep Foundation Record')),
  h('div', { class: 'barbtns' }, h('button', { class: 'fit', onclick: openGeneralCalc, 'aria-label': 'Open calculator' }, 'Calculator'), h('button', { class: 'fit', onclick: openSettings, 'aria-label': 'Settings' }, 'Settings')));
const signed = (kobo) => (kobo < 0 ? '−' : '+') + money(Math.abs(kobo));
const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
const toLocalInput = (iso) => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const memberBal = (id) => { const m = coop.members.find((x) => x.id === id); return m ? m.balance_kobo : 0; };
const KIND_LABEL = { payments: 'Payment', withdrawals: 'Withdrawal' };

const pageNav = (active) => h('div', { class: 'row pagenav' }, ...[['records', 'Collections'], ['cooperative', 'Cooperative'], ['logistics', 'Logistics']].map(([k, l]) =>
  h('button', { class: active === k ? 'on' : '', onclick: () => { location.hash = k; } }, l)));
// Leaving the Cooperative page locks it again, so the Cooperative password is asked every time the page is opened.
function leaveCoop() { coopUi = null; if (coopUnlocked) { coopUnlocked = false; api('/api/coop-auth/lock', { method: 'POST' }).catch(() => {}); } }
function route() {
  if (location.hash !== '#cooperative') leaveCoop();
  if (location.hash === '#cooperative') return showCoop();
  if (location.hash === '#logistics') return showLogistics();
  return showApp(true);
}
window.addEventListener('hashchange', () => { if (document.querySelector('.bar')) route(); });

const coopPage = (...kids) => app.replaceChildren(topBar(), pageNav('cooperative'), h('h2', { class: 'pagetitle' }, 'Waste Recyclers Cooperative'), ...kids);
async function showCoop() {
  amountsShown = false; coopUi = null;
  let st;
  try { st = await api('/api/coop-auth/status'); }
  catch (e) { return coopPage(h('div', { class: 'err' }, e.message), h('button', { onclick: showCoop }, 'Try again')); }
  if (st.unlocked) { coopUnlocked = true; return openCoopPage(); }
  coopUnlocked = false;
  return st.configured ? coopUnlockScreen(st.username) : coopSetupScreen(st.username);
}
function coopUnlockScreen(username) {
  const err = h('div', { class: 'err' }), pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Cooperative password' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Unlock Cooperative');
  coopPage(h('form', { class: 'lockbox', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true, 'Unlocking...');
    try { await api('/api/coop-auth/unlock', { method: 'POST', body: { password: pass.value } }); coopUnlocked = true; openCoopPage(); }
    catch (x) { err.textContent = x.message; busy(btn, false, 'Unlock Cooperative'); }
  } }, h('h3', {}, 'The Cooperative is locked'),
    h('div', { class: 'hint' }, `Signed in as ${username}. Enter your Cooperative password. It is separate from your SweepTrack password.`),
    h('label', {}, 'Cooperative password'), pwField(pass), err, h('div', { class: 'actions' }, btn),
    h('button', { type: 'button', class: 'link', onclick: () => coopResetScreen(username) }, 'Forgot Cooperative password?')));
  pass.focus();
}
function coopSetupScreen(username) {
  const err = h('div', { class: 'err' }), pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, 'aria-label': 'New Cooperative password' });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, 'aria-label': 'Confirm Cooperative password' });
  const qp = questionPicker(), ans = h('input', { type: 'password', autocomplete: 'off', required: true, maxlength: 100, 'aria-label': 'Security answer' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Create Cooperative password');
  coopPage(h('form', { class: 'lockbox', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (pass.value !== pass2.value) { err.textContent = 'The two passwords do not match.'; return; }
    busy(btn, true, 'Creating...');
    try { await api('/api/coop-auth/setup', { method: 'POST', body: { password: pass.value, question: qp.get(), answer: ans.value } }); coopUnlocked = true; openCoopPage(); }
    catch (x) { err.textContent = x.message; busy(btn, false, 'Create Cooperative password'); }
  } }, h('h3', {}, 'Create your Cooperative password'),
    h('div', { class: 'hint' }, `Signed in as ${username}. The Cooperative has its own password. It must be different from your SweepTrack password.`),
    h('label', {}, 'Cooperative password (min 8 characters)'), pwField(pass), h('label', {}, 'Confirm Cooperative password'), pwField(pass2),
    h('label', {}, 'Security question (used to reset the Cooperative password)'), qp.node, h('label', {}, 'Answer'), pwField(ans), err,
    h('div', { class: 'actions' }, btn)));
  pass.focus();
}
async function coopResetScreen(username) {
  const err = h('div', { class: 'err' });
  let question;
  try { question = (await api('/api/coop-auth/reset/question', { method: 'POST', body: {} })).question; }
  catch (e) { toast(e.message, true); return coopUnlockScreen(username); }
  const ans = h('input', { type: 'password', autocomplete: 'off', required: true, maxlength: 100, 'aria-label': 'Security answer' });
  const np = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, 'aria-label': 'New Cooperative password' });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Reset Cooperative password');
  coopPage(h('form', { class: 'lockbox', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true, 'Resetting...');
    try { await api('/api/coop-auth/reset', { method: 'POST', body: { answer: ans.value, new_password: np.value } }); toast('Cooperative password reset. Enter the new password.'); coopUnlockScreen(username); }
    catch (x) { err.textContent = x.message; busy(btn, false, 'Reset Cooperative password'); }
  } }, h('h3', {}, 'Reset Cooperative password'), h('div', { class: 'hint' }, 'Answer the Cooperative security question to set a new Cooperative password.'),
    h('label', {}, question), pwField(ans), h('label', {}, 'New Cooperative password (min 8 characters)'), pwField(np), err,
    h('div', { class: 'actions' }, btn), h('button', { type: 'button', class: 'link', onclick: () => coopUnlockScreen(username) }, 'Back')));
  ans.focus();
}
async function openCoopPage() {
  coopUi = {
    bank: h('div', { class: 'bank' }), totals: h('div'), adj: h('div'), members: h('div'), tx: h('div'),
    filter: h('select', { 'aria-label': 'Filter by member', onchange: (e) => { coop.filter = e.target.value; coop.limit = 20; refreshCoop(); } }),
    more: h('button', { onclick: () => { coop.limit += 20; refreshCoop(); } }, 'Show more'),
    less: h('button', { hidden: true, onclick: () => { coop.limit = 20; refreshCoop(); } }, 'Show less'),
  };
  app.replaceChildren(
    topBar(),
    pageNav('cooperative'),
    h('h2', { class: 'pagetitle' }, 'Waste Recyclers Cooperative'),
    amountsBar(() => renderCoop()), coopUi.bank, coopUi.totals,
    h('div', { class: 'sechead' }, h('h3', {}, 'Manual adjustments'), h('button', { class: 'fit', onclick: () => openAdjForm() }, '+ Adjustment')), coopUi.adj,
    h('div', { class: 'sechead' }, h('h3', {}, 'Members'), h('button', { class: 'fit', onclick: () => openMemberForm() }, '+ Member')), coopUi.members,
    h('div', { class: 'sechead' }, h('h3', {}, 'Transactions')), coopUi.filter, coopUi.tx, h('div', { class: 'row more' }, coopUi.more, coopUi.less),
    h('div', { class: 'fab fabrow' }, h('button', { class: 'primary', onclick: () => openTxForm('payments') }, '+ Payment'), h('button', { onclick: () => openTxForm('withdrawals') }, '− Withdrawal')));
  renderBank(); await refreshCoop();
}
async function refreshCoop() {
  if (!coopUi) return;
  try {
    const q = new URLSearchParams({ limit: String(coop.limit) }); if (coop.filter) q.set('member_id', coop.filter);
    const [ov, tx] = await Promise.all([api('/api/coop/overview'), api('/api/coop/transactions?' + q)]);
    coop.members = Array.isArray(ov && ov.members) ? ov.members : [];
    coop.adjustments = Array.isArray(ov && ov.adjustments) ? ov.adjustments : [];
    coop.totals = (ov && ov.totals) || null;
    coop.tx = Array.isArray(tx && tx.transactions) ? tx.transactions : []; coop.hasMore = !!(tx && tx.has_more);
    if (coop.filter && !coop.members.some((m) => String(m.id) === coop.filter)) coop.filter = '';
    renderCoop();
  } catch (e) { if (e.code === 'coop_locked') return showCoop(); toast(safeMsg(e.message), true); }
}
function renderBank() {
  const mask = '••••••••••';
  coopUi.bank.replaceChildren(
    h('div', { class: 'sechead' }, h('h3', {}, 'Cooperative account'), h('button', { class: 'fit', 'aria-pressed': String(bankShown), onclick: () => { bankShown = !bankShown; renderBank(); } }, bankShown ? 'Hide' : 'Show')),
    h('dl', {}, h('dt', {}, 'Bank'), h('dd', {}, bankShown ? BANK.name : mask),
      h('dt', {}, 'Account No'), h('dd', {}, h('div', { class: 'copyrow' }, h('span', { class: 'mono' }, bankShown ? BANK.no : mask), copyBtn(BANK.no, 'Cooperative account number')))));
}
function renderCoop() {
  const t = coop.totals || { paid_tx: 0, paid_adj: 0, paid_final: 0, withdrawn_tx: 0, withdrawn_adj: 0, withdrawn_final: 0, balance_tx: 0, balance_final: 0 };
  const line = (label, v, cls = '') => h('div', { class: 'tl ' + cls }, h('span', {}, label), h('b', {}, v));
  const block = (title, tx, adj, fin) => h('div', { class: 'tot' }, h('h3', {}, title),
    line('Transaction total', money(tx)), line('Manual adjustment', adj ? signed(adj) : money(0)), line('Final total', money(fin), 'fin'));
  const adjusted = t.paid_adj !== 0 || t.withdrawn_adj !== 0;
  coopUi.totals.replaceChildren(
    block('Total paid into the account', t.paid_tx, t.paid_adj, t.paid_final), block('Total withdrawn', t.withdrawn_tx, t.withdrawn_adj, t.withdrawn_final),
    h('div', { class: 'tot balance' }, h('h3', {}, 'Current Cooperative balance'), h('div', { class: 'big' }, money(t.balance_final)),
      h('div', { class: 'hint' }, 'Total paid − Total withdrawn' + (adjusted ? `. Without adjustments: ${money(t.balance_tx)}.` : '.'))));
  coopUi.adj.replaceChildren(...(coop.adjustments.length ? coop.adjustments.map((a) => h('div', { class: 'card adjrow' },
    h('div', { class: 'top' }, h('span', {}, a.reason), h('span', { class: a.amount_kobo < 0 ? 'neg' : 'posv' }, signed(a.amount_kobo))),
    h('div', { class: 'sub' }, `${a.kind === 'payments' ? 'Total paid' : 'Total withdrawn'}  ·  ${fmtWhen(a.created_at)}`),
    h('div', { class: 'actions' }, h('button', { onclick: () => openAdjForm(a) }, 'Edit'), h('button', { class: 'danger', onclick: () => deleteAdj(a) }, 'Delete')))) : [h('div', { class: 'empty' }, 'No manual adjustments.')]));
  coopUi.members.replaceChildren(...(coop.members.length ? coop.members.map((m) => h('button', { class: 'card', onclick: () => openMember(m) },
    h('div', { class: 'top' }, h('span', {}, m.name), h('span', {}, money(m.balance_kobo))),
    h('div', { class: 'sub' }, `Paid ${money(m.paid_kobo)}  ·  Withdrawn ${money(m.withdrawn_kobo)}`))) : [h('div', { class: 'empty' }, 'No members yet. Record a payment to add the first member.')]));
  coopUi.filter.replaceChildren(h('option', { value: '' }, 'All members'), ...coop.members.map((m) => h('option', { value: String(m.id) }, m.name)));
  coopUi.filter.value = coop.filter;
  coopUi.tx.replaceChildren(...(coop.tx.length ? coop.tx.map((t) => txRow(t)) : [h('div', { class: 'empty' }, 'No transactions yet.')]));
  coopUi.more.hidden = !coop.hasMore; coopUi.less.hidden = coop.tx.length <= 20;
}
const txRow = (t, open = openTx) => h('button', { class: 'card', onclick: () => open(t) },
  h('div', { class: 'top' }, h('span', {}, t.member_name), h('span', { class: t.type === 'payment' ? 'posv' : 'neg' }, (t.type === 'payment' ? '+' : '−') + money(t.amount_kobo))),
  h('div', { class: 'sub' }, `${t.type === 'payment' ? 'Payment' : 'Withdrawal'}  ·  ${fmtWhen(t.occurred_at)}`));

function openTx(t) {
  const kind = t.type === 'payment' ? 'payments' : 'withdrawals';
  const d = dialog(h('h2', {}, KIND_LABEL[kind]),
    h('dl', {}, h('dt', {}, 'Member'), h('dd', {}, t.member_name), h('dt', {}, 'Amount'), h('dd', {}, money(t.amount_kobo)),
      h('dt', {}, 'Date and time'), h('dd', {}, fmtWhen(t.occurred_at)), h('dt', {}, 'Recorded'), h('dd', {}, fmtStamp(t.created_at))),
    h('div', { class: 'err', id: 'derr' }),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { d.close(); openTxForm(kind, t); } }, 'Edit'),
      h('button', { class: 'danger', onclick: async (e) => {
        if (!confirm(`Delete this ${KIND_LABEL[kind].toLowerCase()} of ${money(t.amount_kobo)} for ${t.member_name}? Balances will be recalculated.`)) return;
        busy(e.target, true);
        try { await api(`/api/coop/${kind}/${t.id}`, { method: 'DELETE' }); d.close(); toast(KIND_LABEL[kind] + ' deleted'); refreshCoop(); }
        catch (x) { d.querySelector('#derr').textContent = 'Not deleted: ' + safeMsg(x.message); busy(e.target, false); }
      } }, 'Delete'),
      h('button', { onclick: () => d.close() }, 'Close')));
}
function openTxForm(kind, tx, preset) {
  const pay = kind === 'payments', editing = !!tx, clientId = crypto.randomUUID();
  const sel = h('select', { 'aria-label': 'Member' }, ...coop.members.map((m) => h('option', { value: String(m.id) }, m.name)), ...(pay && !editing ? [h('option', { value: '__new' }, 'New member...')] : []));
  if (tx) sel.value = String(tx.member_id); else if (preset) sel.value = String(preset); else if (pay && !coop.members.length) sel.value = '__new';
  const newName = h('input', { maxlength: 120, autocomplete: 'off', placeholder: 'New member name', 'aria-label': 'New member name', hidden: true });
  const amount = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', required: true, 'aria-label': 'Amount', value: tx ? plain(tx.amount_kobo) : '' });
  const when = editing ? h('input', { type: 'datetime-local', required: true, 'aria-label': 'Date and time', value: toLocalInput(tx.occurred_at) }) : null;
  const note = h('div', { class: 'hint' }), err = h('div', { class: 'err' });
  const btn = h('button', { class: 'primary', type: 'submit' }, editing ? 'Save changes' : pay ? 'Save payment' : 'Save withdrawal');
  function sync() {
    newName.hidden = sel.value !== '__new';
    if (pay) { note.textContent = editing ? '' : 'Date and time are recorded automatically when you save.'; return; }
    if (!coop.members.length) { note.textContent = 'No members yet. Record a payment first.'; btn.disabled = true; return; }
    const id = Number(sel.value); let a = memberBal(id); if (editing && tx.member_id === id) a += tx.amount_kobo;
    note.textContent = `Available balance: ${money(Math.max(a, 0))}. Date and time ${editing ? 'can be corrected below' : 'are recorded automatically'}.`;
  }
  sel.addEventListener('change', sync); sync();
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!toKobo(amount.value)) { err.textContent = 'Enter an amount above zero.'; return; }
    if (sel.value === '__new' && !newName.value.trim()) { err.textContent = 'Enter the new member name.'; newName.focus(); return; }
    const body = { amount: amount.value, ...(sel.value === '__new' ? { member_name: newName.value } : { member_id: Number(sel.value) }) };
    if (when) { const w = new Date(when.value); if (isNaN(w)) { err.textContent = 'Enter a valid date and time.'; return; } body.occurred_at = w.toISOString(); }
    if (!editing) body.client_id = clientId; // reused on retry so a repeated tap cannot record twice
    busy(btn, true, 'Saving...');
    try {
      await api(`/api/coop/${kind}${editing ? '/' + tx.id : ''}`, { method: editing ? 'PUT' : 'POST', body });
      d.close(); toast(KIND_LABEL[kind] + (editing ? ' updated' : ' saved')); refreshCoop();
    } catch (x) { err.textContent = safeMsg(x.message); busy(btn, false, editing ? 'Save changes' : pay ? 'Save payment' : 'Save withdrawal'); }
  } }, h('h2', {}, (editing ? 'Edit ' : 'New ') + KIND_LABEL[kind].toLowerCase()),
    h('label', {}, 'Member'), sel, newName, h('label', {}, 'Amount (₦)'), amount,
    ...(when ? [h('label', {}, 'Date and time'), when] : []), note, err,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
  if (!editing) (sel.value === '__new' ? newName : amount).focus();
}
function openAdjForm(a) {
  const editing = !!a;
  const kind = h('select', { 'aria-label': 'Adjust which total' }, h('option', { value: 'payments' }, 'Total paid'), h('option', { value: 'withdrawals' }, 'Total withdrawn'));
  const dir = h('select', { 'aria-label': 'Increase or decrease' }, h('option', { value: 'increase' }, 'Increase'), h('option', { value: 'decrease' }, 'Decrease'));
  const amount = h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0', required: true, 'aria-label': 'Adjustment amount', value: a ? plain(Math.abs(a.amount_kobo)) : '' });
  const reason = h('input', { maxlength: 300, autocomplete: 'off', required: true, 'aria-label': 'Reason', placeholder: 'Why is this adjustment needed?', value: a ? a.reason : '' });
  if (a) { kind.value = a.kind; dir.value = a.amount_kobo < 0 ? 'decrease' : 'increase'; }
  const err = h('div', { class: 'err' }), btn = h('button', { class: 'primary', type: 'submit' }, editing ? 'Save changes' : 'Save adjustment');
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!toKobo(amount.value)) { err.textContent = 'Enter an amount above zero.'; return; }
    busy(btn, true, 'Saving...');
    try {
      await api('/api/coop/adjustments' + (editing ? '/' + a.id : ''), { method: editing ? 'PUT' : 'POST', body: { kind: kind.value, direction: dir.value, amount: amount.value, reason: reason.value } });
      d.close(); toast(editing ? 'Adjustment updated' : 'Adjustment saved'); refreshCoop();
    } catch (x) { err.textContent = safeMsg(x.message); busy(btn, false, editing ? 'Save changes' : 'Save adjustment'); }
  } }, h('h2', {}, editing ? 'Edit adjustment' : 'New manual adjustment'),
    h('div', { class: 'hint' }, 'Adjustments are kept separate. Transactions are never changed or deleted by an adjustment.'),
    h('label', {}, 'Adjust'), kind, h('label', {}, 'Change'), dir, h('label', {}, 'Amount (₦)'), amount, h('label', {}, 'Reason'), reason, err,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
}
async function deleteAdj(a) {
  if (!confirm(`Delete this adjustment (${signed(a.amount_kobo)})? Only the adjustment is removed. All transactions stay.`)) return;
  try { await api('/api/coop/adjustments/' + a.id, { method: 'DELETE' }); toast('Adjustment deleted'); refreshCoop(); } catch (e) { toast(safeMsg(e.message), true); }
}
function openMemberForm(m) {
  const name = h('input', { required: true, maxlength: 120, autocomplete: 'off', 'aria-label': 'Member name', value: m ? m.name : '' });
  const err = h('div', { class: 'err' }), btn = h('button', { class: 'primary', type: 'submit' }, m ? 'Save name' : 'Add member');
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; busy(btn, true);
    try { await api('/api/coop/members' + (m ? '/' + m.id : ''), { method: m ? 'PUT' : 'POST', body: { name: name.value } }); d.close(); toast(m ? 'Member renamed' : 'Member added'); refreshCoop(); }
    catch (x) { err.textContent = safeMsg(x.message); busy(btn, false); }
  } }, h('h2', {}, m ? 'Rename member' : 'New member'), h('label', {}, 'Member name'), name, err,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
  name.focus();
}
function openMember(m) {
  const list = h('div'), err = h('div', { class: 'err' });
  const d = dialog(h('h2', {}, m.name),
    h('div', { class: 'stats' }, ...[['Total paid', m.paid_kobo], ['Total withdrawn', m.withdrawn_kobo], ['Current balance', m.balance_kobo]].map(([l, v]) => h('div', { class: 'stat' }, h('span', {}, l), h('b', {}, money(v))))),
    h('div', { class: 'hint' }, 'Total paid − Total withdrawn = Current balance'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { d.close(); openTxForm('payments', null, m.id); } }, '+ Payment'),
      h('button', { disabled: m.balance_kobo <= 0, onclick: () => { d.close(); openTxForm('withdrawals', null, m.id); } }, '− Withdrawal')),
    h('h3', {}, 'Transactions'), list, err,
    h('div', { class: 'actions' }, h('button', { onclick: () => { d.close(); openMemberForm(m); } }, 'Rename'),
      h('button', { class: 'danger', disabled: m.tx_count > 0, title: m.tx_count > 0 ? 'Remove the transactions first' : '', onclick: async (e) => {
        if (!confirm(`Delete member ${m.name}?`)) return; busy(e.target, true);
        try { await api('/api/coop/members/' + m.id, { method: 'DELETE' }); d.close(); toast('Member deleted'); refreshCoop(); }
        catch (x) { err.textContent = safeMsg(x.message); busy(e.target, false); }
      } }, 'Delete member'), h('button', { onclick: () => d.close() }, 'Close')));
  api('/api/coop/transactions?limit=50&member_id=' + m.id).then((r) => {
    const rows = Array.isArray(r && r.transactions) ? r.transactions : [];
    list.replaceChildren(...(rows.length ? rows.map((t) => txRow(t, (x) => { d.close(); openTx(x); })) : [h('div', { class: 'empty' }, 'No transactions yet.')]));
  }).catch((x) => { err.textContent = safeMsg(x.message); });
}

// ---------- Logistics (the organisation's own expenses, separate from customer collection records) ----------
const logi = { items: [], total: 0, count: 0, hasMore: false, limit: 20 };
const dateOnly = (iso) => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const timeOnly = (iso) => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
async function showLogistics() {
  amountsShown = false;
  logiUi = { total: h('div', { class: 'tot balance' }), list: h('div'),
    more: h('button', { onclick: () => { logi.limit += 20; refreshLogistics(); } }, 'Show more'), less: h('button', { hidden: true, onclick: () => { logi.limit = 20; refreshLogistics(); } }, 'Show less') };
  app.replaceChildren(topBar(), pageNav('logistics'), h('h2', { class: 'pagetitle' }, 'Logistics'),
    h('div', { class: 'hint' }, 'The organisation\'s own expenses. Kept separate from customer collection records.'),
    amountsBar(() => renderLogistics()), logiUi.total,
    h('div', { class: 'sechead' }, h('h3', {}, 'Records')), logiUi.list, h('div', { class: 'row more' }, logiUi.more, logiUi.less),
    h('button', { class: 'primary fab', onclick: () => openLogiForm() }, '+ Logistics'));
  renderLogistics(); await refreshLogistics();
}
async function refreshLogistics() {
  if (!logiUi) return;
  try {
    const d = await api('/api/logistics?limit=' + logi.limit);
    logi.items = Array.isArray(d && d.items) ? d.items : []; logi.total = Number(d && d.total_kobo) || 0; logi.count = Number(d && d.count) || 0; logi.hasMore = !!(d && d.has_more);
    renderLogistics();
  } catch (e) { toast(safeMsg(e.message), true); }
}
function renderLogistics() {
  if (!logiUi) return;
  logiUi.total.replaceChildren(h('h3', {}, 'Total logistics amount'), h('div', { class: 'big' }, money(logi.total)), h('div', { class: 'hint' }, `${logi.count} record${logi.count === 1 ? '' : 's'}`));
  logiUi.list.replaceChildren(...(logi.items.length ? logi.items.map((t) => h('button', { class: 'card', onclick: () => openLogiDetail(t) },
    h('div', { class: 'top' }, h('span', {}, t.purpose), h('span', {}, money(t.amount_kobo))),
    h('div', { class: 'sub' }, fmtWhen(t.occurred_at)), t.remark ? h('div', { class: 'sub clip' }, t.remark) : null)) : [h('div', { class: 'empty' }, 'No logistics records yet.')]));
  logiUi.more.hidden = !logi.hasMore; logiUi.less.hidden = logi.items.length <= 20;
}
function openLogiDetail(t) {
  const d = dialog(h('h2', {}, t.purpose),
    h('dl', {}, h('dt', {}, 'Amount'), h('dd', {}, money(t.amount_kobo)), h('dt', {}, 'Date'), h('dd', {}, dateOnly(t.occurred_at)), h('dt', {}, 'Time'), h('dd', {}, timeOnly(t.occurred_at)),
      h('dt', {}, 'Remark'), h('dd', {}, t.remark || '-')),
    h('div', { class: 'err', id: 'derr' }),
    h('div', { class: 'actions' },
      h('button', { onclick: () => { d.close(); openLogiForm(t); } }, 'Edit'),
      h('button', { class: 'danger', onclick: async (e) => {
        if (!confirm(`Delete this logistics record (${t.purpose}, ${money(t.amount_kobo)})? The total will be recalculated.`)) return;
        busy(e.target, true);
        try { await api('/api/logistics/' + t.id, { method: 'DELETE' }); d.close(); toast('Logistics record deleted'); refreshLogistics(); }
        catch (x) { d.querySelector('#derr').textContent = 'Not deleted: ' + safeMsg(x.message); busy(e.target, false); }
      } }, 'Delete'),
      h('button', { onclick: () => d.close() }, 'Close')));
}
function openLogiForm(t) {
  const editing = !!t, clientId = crypto.randomUUID();
  const purpose = h('input', { required: true, maxlength: 200, autocomplete: 'off', 'aria-label': 'Item or purpose', value: t ? t.purpose : '' });
  const amount = h('input', { required: true, inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', value: t ? plain(t.amount_kobo) : '' });
  const when = h('input', { type: 'datetime-local', required: true, 'aria-label': 'Date and time', value: toLocalInput(t ? t.occurred_at : new Date().toISOString()) });
  const remark = h('input', { maxlength: 300, autocomplete: 'off', 'aria-label': 'Remark', value: t ? t.remark : '' });
  let touched = false; when.addEventListener('input', () => { touched = true; });
  const err = h('div', { class: 'err' }), btn = h('button', { class: 'primary', type: 'submit' }, editing ? 'Save changes' : 'Save');
  const d = dialog(h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!toKobo(amount.value)) { err.textContent = 'Enter an amount above zero.'; return; }
    const body = { purpose: purpose.value, amount: amount.value, remark: remark.value };
    if (editing || touched) { const w = new Date(when.value); if (isNaN(w)) { err.textContent = 'Enter a valid date and time.'; return; } body.occurred_at = w.toISOString(); } // untouched on a new record: the server stamps the real time
    if (!editing) body.client_id = clientId;
    busy(btn, true, 'Saving...');
    try { await api('/api/logistics' + (editing ? '/' + t.id : ''), { method: editing ? 'PUT' : 'POST', body }); d.close(); toast(editing ? 'Logistics record updated' : 'Logistics record saved'); refreshLogistics(); }
    catch (x) { err.textContent = safeMsg(x.message); busy(btn, false, editing ? 'Save changes' : 'Save'); }
  } }, h('h2', {}, editing ? 'Edit logistics record' : 'New logistics record'),
    h('label', {}, 'Item or purpose'), purpose, h('label', {}, 'Amount (₦)'), amount, h('label', {}, 'Date and time'), when,
    h('div', { class: 'hint' }, editing ? '' : 'The current date and time are used unless you change them.'), h('label', {}, 'Remark (optional)'), remark, err,
    h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), btn)));
  purpose.focus();
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
    const res = await fetch(API_URL + '/api/export?' + params, { credentials: 'include', headers: { 'X-Requested-With': 'sweep' } });
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
if (API_URL.includes('YOUR-WORKER')) { // the address above has not been filled in yet
  app.replaceChildren(h('div', { class: 'lockbox' }, h('h3', {}, 'One more step'), h('div', { class: 'hint' }, 'Open app.js and replace the Worker address at the top (API_URL) with the address of your SweepTrack Worker.')));
} else api('/api/me').then(() => showApp()).catch(() => { if (!document.querySelector('.login')) showAuth(); });
