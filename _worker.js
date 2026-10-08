// SweepTrack API, served by Cloudflare Pages advanced mode (_worker.js at the project root).
// Works with dashboard zip uploads, which do not compile a functions/ folder. Uses the existing D1 binding `DB` (database sweep-db).
// Tables used: users, sessions, login_attempts, records, record_items. No schema changes are made here.

const PLASTICS = ['PET', 'HDPE', 'PVC', 'LDPE', 'PP', 'PS', 'Other'];
const COOKIE = 'sweep_session';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days, extended with use
const ITER = 100000; // Workers cap PBKDF2 at 100000
const DIGEST_BY_LEN = { 20: 'SHA-1', 32: 'SHA-256', 48: 'SHA-384', 64: 'SHA-512' };
const enc = new TextEncoder();

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const fail = (status, message, code) => new HttpError(status, message, code);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

// ---------- bytes and crypto ----------
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
const isHex = (s) => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
const isB64 = (s) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(s);
function fromB64(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const sha256Hex = async (str) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str))));
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function pbkdf2(secret, salt, iterations, hash, len) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash }, key, len * 8));
}
// New secrets are stored as: salt "v2:<hex>", hash <hex>, PBKDF2 SHA-256, 100000 iterations.
async function makeSecret(secret) {
  const salt = randomHex(16);
  return { hash: toHex(await pbkdf2(secret, fromHex(salt), ITER, 'SHA-256', 32)), salt: 'v2:' + salt, iterations: ITER };
}
// Verifies new (v2) secrets exactly, and also reads secrets saved by the earlier version of the app
// (PBKDF2 with a hex, base64 or plain text salt) so existing accounts keep working.
async function verifySecret(secret, hashStr, saltStr, iterations) {
  try {
    hashStr = String(hashStr || ''); saltStr = String(saltStr || '');
    if (saltStr.startsWith('v2:')) {
      const d = await pbkdf2(secret, fromHex(saltStr.slice(3)), Number(iterations) || ITER, 'SHA-256', 32);
      return safeEqual(d, fromHex(hashStr));
    }
    let stored = null;
    if (isHex(hashStr) && DIGEST_BY_LEN[hashStr.length / 2]) stored = fromHex(hashStr);
    else if (isB64(hashStr)) { try { const b = fromB64(hashStr); if (DIGEST_BY_LEN[b.length]) stored = b; } catch {} }
    if (!stored) return false;
    const salts = [];
    if (isHex(saltStr)) salts.push(fromHex(saltStr));
    if (isB64(saltStr)) { try { salts.push(fromB64(saltStr)); } catch {} }
    salts.push(enc.encode(saltStr));
    const iter = Number(iterations) || ITER;
    for (const salt of salts) {
      const d = await pbkdf2(secret, salt, iter, DIGEST_BY_LEN[stored.length], stored.length);
      if (safeEqual(d, stored)) return true;
    }
  } catch {}
  return false;
}
const normAnswer = (a) => String(a || '').trim().toLowerCase();
async function verifyAnswer(user, answer) {
  const tries = [...new Set([normAnswer(answer), String(answer || '').trim(), String(answer || '')])];
  const v2 = String(user.answer_salt || '').startsWith('v2:');
  for (const t of v2 ? tries.slice(0, 1) : tries) if (t && await verifySecret(t, user.answer_hash, user.answer_salt, user.iterations)) return true;
  return false;
}

// ---------- small helpers ----------
const nowIso = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
function cookieOf(request, name) {
  const m = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) throw fail(413, 'Request too large.');
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw fail(400, 'Invalid request.');
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}
function parseNaira(v) {
  const t = str(v).trim().replace(/,/g, '');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) throw fail(400, 'Enter a valid amount in naira (up to 2 decimal places).');
  const [i, f = ''] = t.split('.'); return Number(i) * 100 + Number(f.padEnd(2, '0'));
}
function parseKg(v) {
  const t = str(v).trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(t)) throw fail(400, 'Enter a valid KG amount (up to 3 decimal places).');
  const [i, f = ''] = t.split('.'); return Number(i) * 1000 + Number(f.padEnd(3, '0'));
}
const fmtMilli = (m) => { const f = String(m % 1000).padStart(3, '0').replace(/0+$/, ''); return Math.floor(m / 1000) + (f ? '.' + f : ''); };
const fmtKobo = (k) => Math.floor(k / 100) + '.' + String(k % 100).padStart(2, '0');
// one plastic type line: KG x price per KG, in kobo, rounded to the nearest kobo (exact integer maths)
const lineKobo = (kgMilli, rateKobo) => Number((BigInt(kgMilli) * BigInt(rateKobo) + 500n) / 1000n);
const ratePerKg = (kgMilli, kobo) => (kgMilli > 0 && kobo > 0 ? Math.round(kobo * 1000 / kgMilli) : null);

// ---------- sessions and sign in limits ----------
async function createSession(env, userId) {
  const token = randomHex(32), now = nowIso();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now).run();
  if (Math.random() < 0.05) { // occasional cleanup of expired sessions
    await env.DB.prepare('DELETE FROM sessions WHERE last_seen_at < ?').bind(new Date(Date.now() - SESSION_MS).toISOString()).run().catch(() => {});
  }
  return token;
}
async function getSession(env, request) {
  const token = cookieOf(request, COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const th = await sha256Hex(token);
  const s = await env.DB.prepare('SELECT s.user_id, s.created_at, s.last_seen_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(th).first();
  if (!s) return null;
  const seen = Date.parse(s.last_seen_at) || 0;
  if (Date.now() - seen > SESSION_MS) { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run(); return null; }
  if (Date.now() - seen > 3600 * 1000) { // extend, at most once an hour
    s.last_seen_at = nowIso();
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(s.last_seen_at, th).run();
  }
  return { ...s, token_hash: th, expires: new Date((Date.parse(s.last_seen_at) || Date.now()) + SESSION_MS).toISOString() };
}
const WINDOW = 900; // 15 minutes
async function throttleCheck(env, key, max) {
  const r = await env.DB.prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?').bind(key).first();
  const now = Math.floor(Date.now() / 1000);
  if (r && now - r.window_start < WINDOW && r.failures >= max) throw fail(429, `Too many attempts. Try again in ${Math.ceil((WINDOW - (now - r.window_start)) / 60)} minutes.`);
}
async function throttleFail(env, key) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO login_attempts (key, failures, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      failures = CASE WHEN ?2 - window_start >= ${WINDOW} THEN 1 ELSE failures + 1 END,
      window_start = CASE WHEN ?2 - window_start >= ${WINDOW} THEN ?2 ELSE window_start END`).bind(key, now).run();
}
const throttleClear = (env, key) => env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
const ipOf = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

// ---------- account routes ----------
function checkNewPassword(p) { if (typeof p !== 'string' || p.length < 8) throw fail(400, 'Password must be at least 8 characters.'); if (p.length > 200) throw fail(400, 'Password is too long.'); }
function checkQuestion(q, a) {
  q = str(q).trim(); a = str(a);
  if (!q || q.length > 120) throw fail(400, 'Enter a security question (up to 120 characters).');
  if (normAnswer(a).length < 2 || a.length > 100) throw fail(400, 'Enter an answer to your security question.');
  return q;
}
async function userByName(env, username) {
  return env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(str(username).trim()).first();
}
async function startSession(env, userId) {
  const token = await createSession(env, userId);
  return { 'set-cookie': sessionCookie(token, SESSION_MS / 1000) };
}

async function authRoutes(path, method, request, env) {
  if (path === '/api/auth/status' && method === 'GET') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ setup_needed: !r || r.n === 0 });
  }
  if (path === '/api/signup' && method === 'POST') {
    const b = await readJson(request);
    const username = str(b.username).trim();
    if (!username || username.length > 64) throw fail(400, 'Enter a username (up to 64 characters).');
    checkNewPassword(b.password); const question = checkQuestion(b.question, b.answer);
    const pw = await makeSecret(b.password), an = await makeSecret(normAnswer(b.answer));
    const res = await env.DB.prepare(`INSERT INTO users (username, password_hash, salt, iterations, created_at, security_question, answer_hash, answer_salt)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`)
      .bind(username, pw.hash, pw.salt, pw.iterations, nowIso(), question, an.hash, an.salt).run();
    if (!res.meta || res.meta.changes === 0) throw fail(403, 'Sign up is closed. Please sign in.');
    const u = await userByName(env, username);
    return json({ ok: true }, 200, await startSession(env, u.id));
  }
  if (path === '/api/login' && method === 'POST') {
    const b = await readJson(request), username = str(b.username).trim(), password = str(b.password);
    const k1 = 'login:' + username.toLowerCase(), k2 = 'login-ip:' + ipOf(request);
    await throttleCheck(env, k1, 10); await throttleCheck(env, k2, 40);
    const u = username && password ? await userByName(env, username) : null;
    if (!u || !(await verifySecret(password, u.password_hash, u.salt, u.iterations))) {
      await throttleFail(env, k1); await throttleFail(env, k2);
      throw fail(401, 'Wrong username or password.');
    }
    if (!String(u.salt).startsWith('v2:')) { // move an older stored password to the current format after a correct sign in
      const pw = await makeSecret(password);
      await env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?').bind(pw.hash, pw.salt, pw.iterations, u.id).run().catch(() => {});
    }
    await throttleClear(env, k1);
    return json({ ok: true }, 200, await startSession(env, u.id));
  }
  if (path === '/api/reset/question' && method === 'POST') {
    const b = await readJson(request), username = str(b.username).trim();
    await throttleCheck(env, 'reset-q:' + ipOf(request), 30);
    const u = username ? await userByName(env, username) : null;
    if (!u) { await throttleFail(env, 'reset-q:' + ipOf(request)); throw fail(404, 'No account found with that username.'); }
    if (!u.security_question || !u.answer_hash) throw fail(400, 'No security question is set for this account.');
    return json({ question: u.security_question });
  }
  if (path === '/api/reset' && method === 'POST') {
    const b = await readJson(request), username = str(b.username).trim(), key = 'reset:' + username.toLowerCase();
    await throttleCheck(env, key, 5);
    checkNewPassword(b.new_password);
    const u = username ? await userByName(env, username) : null;
    if (!u || !u.answer_hash || !(await verifyAnswer(u, b.answer))) { await throttleFail(env, key); throw fail(403, 'That answer is not correct.'); }
    const pw = await makeSecret(b.new_password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?').bind(pw.hash, pw.salt, pw.iterations, u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
    ]);
    await dropCoopSessions(env, u.id);
    await throttleClear(env, key); await throttleClear(env, 'login:' + username.toLowerCase());
    return json({ ok: true });
  }
  return null;
}

async function accountRoutes(path, method, request, env, session) {
  if (path === '/api/me' && method === 'GET') return json({ username: session.username, session_created: session.created_at, session_expires: session.expires });
  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
    await dropCoopSessions(env, session.user_id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }
  if (path === '/api/password' && method === 'POST') {
    const b = await readJson(request); checkNewPassword(b.new_password);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
    const key = 'pw:' + session.user_id; await throttleCheck(env, key, 8);
    if (!(await verifySecret(str(b.current_password), u.password_hash, u.salt, u.iterations))) { await throttleFail(env, key); throw fail(403, 'Current password is incorrect.'); }
    const pw = await makeSecret(b.new_password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?').bind(pw.hash, pw.salt, pw.iterations, u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(u.id, session.token_hash),
    ]);
    await throttleClear(env, key);
    return json({ ok: true });
  }
  if (path === '/api/security' && method === 'POST') {
    const b = await readJson(request), question = checkQuestion(b.question, b.answer);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
    const key = 'pw:' + session.user_id; await throttleCheck(env, key, 8);
    if (!(await verifySecret(str(b.current_password), u.password_hash, u.salt, u.iterations))) { await throttleFail(env, key); throw fail(403, 'Current password is incorrect.'); }
    const an = await makeSecret(normAnswer(b.answer));
    await env.DB.prepare('UPDATE users SET security_question = ?, answer_hash = ?, answer_salt = ? WHERE id = ?').bind(question, an.hash, an.salt, u.id).run();
    await throttleClear(env, key);
    return json({ ok: true });
  }
  return null;
}

// ---------- records ----------
function filters(url) {
  const where = [], args = [];
  const from = url.searchParams.get('from'), to = url.searchParams.get('to'), q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (from) { if (!validDate(from)) throw fail(400, 'Invalid start date.'); where.push('date >= ?'); args.push(from); }
  if (to) { if (!validDate(to)) throw fail(400, 'Invalid end date.'); where.push('date <= ?'); args.push(to); }
  if (q) { where.push("customer_name LIKE ? ESCAPE '\\'"); args.push('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  return { where, args };
}
async function attachItems(env, rows) {
  const items = new Map(rows.map((r) => [r.id, []]));
  if (rows.length) {
    const rateCol = await hasColumn(env, 'record_items', 'rate_kobo');
    const { results } = await env.DB.prepare(`SELECT record_id, plastic_type, kg_milli${rateCol ? ', rate_kobo' : ''} FROM record_items WHERE record_id IN (${rows.map(() => '?').join(',')})`).bind(...rows.map((r) => r.id)).all();
    for (const it of results || []) items.get(it.record_id)?.push({ type: it.plastic_type, kg_milli: it.kg_milli, rate_kobo: it.rate_kobo ?? null });
    for (const list of items.values()) list.sort((a, b) => PLASTICS.indexOf(a.type) - PLASTICS.indexOf(b.type));
  }
  return rows.map((r) => ({
    id: r.id, date: r.date, customer_name: r.customer_name, address: r.address || '', phone: r.phone || '', account_no: r.account_no || '', bank_name: r.bank_name || '',
    kg_milli: r.kg_milli, amount_kobo: r.amount_kobo, remark: r.remark || '', items: items.get(r.id) || [],
    created_at: r.created_at, updated_at: r.updated_at,
  }));
}
async function getRecord(env, where, arg) {
  const row = await env.DB.prepare(`SELECT * FROM records WHERE ${where}`).bind(arg).first();
  return row ? (await attachItems(env, [row]))[0] : null;
}
// Account No, Bank Name and price per KG live in columns added by the SQL migration. Until they exist, records still work without them.
const haveCols = new Set();
async function hasColumn(env, table, col) { // table and col are fixed names from this file, never user input
  const key = table + '.' + col;
  if (haveCols.has(key)) return true;
  try { await env.DB.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).first(); haveCols.add(key); return true; } catch { return false; }
}
const NEEDS_UPDATE = 'Account No, Bank Name and price per KG need the database update. Run the SQL migration in the D1 console, then try again.';
function parseRecordBody(b) {
  const date = str(b.date).trim(); if (!validDate(date)) throw fail(400, 'Enter a valid date.');
  const customer_name = str(b.customer_name).trim(); if (!customer_name || customer_name.length > 120) throw fail(400, 'Enter the customer name (up to 120 characters).');
  const address = str(b.address).trim(); if (address.length > 300) throw fail(400, 'Address is too long (300 characters at most).');
  const phone = str(b.phone).trim();
  if (phone.length > 30) throw fail(400, 'Phone No is too long (30 characters at most).');
  if (phone && !/^[0-9+()\-\s./]+$/.test(phone)) throw fail(400, 'Phone No can only contain digits, spaces and + ( ) - . /');
  const account = str(b.account_no).trim();
  if (account.length > 30) throw fail(400, 'Account No is too long (30 characters at most).');
  if (account && !/^[0-9A-Za-z\s\-./]+$/.test(account)) throw fail(400, 'Account No can only contain letters, digits, spaces and - . /');
  const bank = str(b.bank_name).trim();
  if (bank.length > 60) throw fail(400, 'Bank Name is too long (60 characters at most).');
  if (bank && !/^[\p{L}\p{N}\s&.,'()\-/]+$/u.test(bank)) throw fail(400, "Bank Name can only contain letters, digits, spaces and & . , ' ( ) - /");
  const remark = str(b.remark).trim(); if (remark.length > 500) throw fail(400, 'Remark is too long (500 characters at most).');
  const items = [];
  if (b.items != null && !Array.isArray(b.items)) throw fail(400, 'Invalid plastic types.');
  for (const it of b.items || []) {
    const type = str(it && it.type);
    if (!PLASTICS.includes(type)) throw fail(400, 'Unknown plastic type.');
    if (items.some((x) => x.type === type)) throw fail(400, `${type} was added twice.`);
    const kg_milli = parseKg(it.kg); if (kg_milli <= 0) throw fail(400, `Enter a KG amount above zero for ${type}.`);
    let rate_kobo = null; // price per KG for this plastic type (optional only for records saved before prices existed)
    if (it.rate != null && str(it.rate).trim() !== '') {
      try { rate_kobo = parseNaira(it.rate); } catch { throw fail(400, `Enter a valid price per KG for ${type} (up to 2 decimal places).`); }
      if (rate_kobo <= 0) throw fail(400, `Enter a price per KG above zero for ${type}.`);
      if (rate_kobo > 100000000) throw fail(400, `The price per KG for ${type} is too high.`);
    }
    items.push({ type, kg_milli, rate_kobo });
  }
  // when every type has its own price, the total paid is the sum of KG x price per type; otherwise the entered amount is used
  let amount_kobo;
  if (items.length && items.every((i) => i.rate_kobo != null)) {
    amount_kobo = items.reduce((sum, i) => sum + lineKobo(i.kg_milli, i.rate_kobo), 0);
    if (amount_kobo > 999999999999) throw fail(400, 'The total amount is too large.');
  } else amount_kobo = parseNaira(b.amount);
  let kg_milli;
  if (items.length) kg_milli = items.reduce((s, i) => s + i.kg_milli, 0);
  else if (b.kg != null && str(b.kg).trim() !== '') kg_milli = parseKg(b.kg);
  else throw fail(400, 'Select at least one plastic type.');
  // address, phone and account_no stay undefined when the request does not mention them, so an edit from an older screen never wipes them
  return { date, customer_name, address: 'address' in b ? address || null : undefined, phone: 'phone' in b ? phone || null : undefined,
    account_no: 'account_no' in b ? account || null : undefined, bank_name: 'bank_name' in b ? bank || null : undefined, remark, amount_kobo, items, kg_milli };
}

async function recordRoutes(path, method, request, env) {
  const url = new URL(request.url);
  if (path === '/api/summary' && method === 'GET') {
    const { where, args } = filters(url);
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(kg_milli),0) AS kg, COALESCE(SUM(amount_kobo),0) AS amt,
      COALESCE(SUM(CASE WHEN remark LIKE '%pending%' THEN 1 ELSE 0 END),0) AS p FROM records ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).bind(...args).first();
    return json({ count: r.c, kg_milli: r.kg, amount_kobo: r.amt, pending: r.p });
  }
  if (path === '/api/records' && method === 'GET') {
    const { where, args } = filters(url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 50);
    const cur = url.searchParams.get('cursor');
    if (cur) {
      const m = /^(\d{4}-\d{2}-\d{2})\|(\d+)$/.exec(cur); if (!m) throw fail(400, 'Invalid cursor.');
      where.push('(date < ? OR (date = ? AND id < ?))'); args.push(m[1], m[1], Number(m[2]));
    }
    const { results } = await env.DB.prepare(`SELECT * FROM records ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ?`).bind(...args, limit + 1).all();
    const more = results.length > limit, page = results.slice(0, limit);
    return json({ records: await attachItems(env, page), next_cursor: more ? `${page[page.length - 1].date}|${page[page.length - 1].id}` : null });
  }
  if (path === '/api/records' && method === 'POST') {
    const b = await readJson(request), rec = parseRecordBody(b);
    const cid = /^[\w-]{8,64}$/.test(str(b.client_id)) ? b.client_id : crypto.randomUUID();
    const dup = await getRecord(env, 'client_id = ?', cid); // a repeated submit returns the first save instead of a duplicate
    if (dup) return json({ ok: true, record: dup });
    const now = nowIso(), [acct, bank, rateCol] = await Promise.all([hasColumn(env, 'records', 'account_no'), hasColumn(env, 'records', 'bank_name'), hasColumn(env, 'record_items', 'rate_kobo')]);
    if ((!acct && rec.account_no) || (!bank && rec.bank_name) || (!rateCol && rec.items.some((i) => i.rate_kobo != null))) throw fail(503, NEEDS_UPDATE);
    const f = [['client_id', cid], ['date', rec.date], ['customer_name', rec.customer_name], ['address', rec.address ?? null], ['phone', rec.phone ?? null],
      ...(acct ? [['account_no', rec.account_no ?? null]] : []), ...(bank ? [['bank_name', rec.bank_name ?? null]] : []), ['kg_milli', rec.kg_milli], ['amount_kobo', rec.amount_kobo], ['remark', rec.remark], ['created_at', now], ['updated_at', now]];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO records (${f.map((x) => x[0]).join(', ')}) VALUES (${f.map(() => '?').join(', ')})`).bind(...f.map((x) => x[1])),
      ...rec.items.map((i) => env.DB.prepare(`INSERT INTO record_items (record_id, plastic_type, kg_milli${rateCol ? ', rate_kobo' : ''}) VALUES ((SELECT id FROM records WHERE client_id = ?), ?, ?${rateCol ? ', ?' : ''})`).bind(cid, i.type, i.kg_milli, ...(rateCol ? [i.rate_kobo] : []))),
    ]);
    return json({ ok: true, record: await getRecord(env, 'client_id = ?', cid) }, 201);
  }
  const m = /^\/api\/records\/(\d+)$/.exec(path);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(m[1]);
    if (!(await env.DB.prepare('SELECT id FROM records WHERE id = ?').bind(id).first())) throw fail(404, 'Record not found. It may already be deleted.');
    if (method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM record_items WHERE record_id = ?').bind(id), env.DB.prepare('DELETE FROM records WHERE id = ?').bind(id)]);
      return json({ ok: true });
    }
    const rec = parseRecordBody(await readJson(request)), [acct, bank, rateCol] = await Promise.all([hasColumn(env, 'records', 'account_no'), hasColumn(env, 'records', 'bank_name'), hasColumn(env, 'record_items', 'rate_kobo')]);
    if ((!acct && rec.account_no) || (!bank && rec.bank_name) || (!rateCol && rec.items.some((i) => i.rate_kobo != null))) throw fail(503, NEEDS_UPDATE);
    const u = [['date', rec.date], ['customer_name', rec.customer_name], ['kg_milli', rec.kg_milli], ['amount_kobo', rec.amount_kobo], ['remark', rec.remark], ['updated_at', nowIso()],
      ...(rec.address !== undefined ? [['address', rec.address]] : []), ...(rec.phone !== undefined ? [['phone', rec.phone]] : []),
      ...(acct && rec.account_no !== undefined ? [['account_no', rec.account_no]] : []), ...(bank && rec.bank_name !== undefined ? [['bank_name', rec.bank_name]] : [])];
    await env.DB.batch([
      env.DB.prepare(`UPDATE records SET ${u.map((x) => x[0] + ' = ?').join(', ')} WHERE id = ?`).bind(...u.map((x) => x[1]), id),
      env.DB.prepare('DELETE FROM record_items WHERE record_id = ?').bind(id),
      ...rec.items.map((i) => env.DB.prepare(`INSERT INTO record_items (record_id, plastic_type, kg_milli${rateCol ? ', rate_kobo' : ''}) VALUES (?, ?, ?${rateCol ? ', ?' : ''})`).bind(id, i.type, i.kg_milli, ...(rateCol ? [i.rate_kobo] : []))),
    ]);
    return json({ ok: true, record: await getRecord(env, 'id = ?', id) });
  }
  if (path === '/api/export' && method === 'GET') return exportCsv(url, env);
  return null;
}

// ---------- Cooperative password (separate from the SweepTrack sign in password) ----------
// The Cooperative has its own password and its own short lived unlock. Every /api/coop/ route requires the unlock.
const COOP_COOKIE = 'sweep_coop', COOP_IDLE_MS = 20 * 60 * 1000;
const coopCookie = (token, clear) => `${COOP_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${clear ? '; Max-Age=0' : ''}`; // a browser session cookie
async function dropCoopSessions(env, userId) { try { await env.DB.prepare('DELETE FROM coop_sessions WHERE user_id = ?').bind(userId).run(); } catch { /* the table exists once the SQL migration has run */ } }
async function coopAccess(env, request, session) {
  const token = cookieOf(request, COOP_COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const th = await sha256Hex(token);
  const s = await env.DB.prepare('SELECT user_id, last_seen_at FROM coop_sessions WHERE token_hash = ?').bind(th).first();
  if (!s || s.user_id !== session.user_id) return false;
  const seen = Date.parse(s.last_seen_at) || 0;
  if (Date.now() - seen > COOP_IDLE_MS) { await env.DB.prepare('DELETE FROM coop_sessions WHERE token_hash = ?').bind(th).run(); return false; }
  if (Date.now() - seen > 60 * 1000) await env.DB.prepare('UPDATE coop_sessions SET last_seen_at = ? WHERE token_hash = ?').bind(nowIso(), th).run();
  return true;
}
async function startCoopSession(env, userId) {
  const token = randomHex(32), now = nowIso();
  await env.DB.prepare('DELETE FROM coop_sessions WHERE user_id = ? AND last_seen_at < ?').bind(userId, new Date(Date.now() - COOP_IDLE_MS).toISOString()).run();
  await env.DB.prepare('INSERT INTO coop_sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), userId, now, now).run();
  return { 'set-cookie': coopCookie(token) };
}
async function sameAsLoginPassword(env, userId, password) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  return !!u && (await verifySecret(str(password), u.password_hash, u.salt, u.iterations));
}
const SAME_PW = 'The Cooperative password must be different from your SweepTrack password.';
async function coopAuthRoutes(path, method, request, env, session) {
  if (!path.startsWith('/api/coop-auth/')) return null;
  const uid = session.user_id, row = () => env.DB.prepare('SELECT * FROM coop_auth WHERE user_id = ?').bind(uid).first();
  if (path === '/api/coop-auth/status' && method === 'GET') {
    const c = await row();
    return json({ configured: !!c, unlocked: !!c && (await coopAccess(env, request, session)), username: session.username });
  }
  if (path === '/api/coop-auth/setup' && method === 'POST') {
    if (await row()) throw fail(409, 'A Cooperative password already exists. Enter it, or use Forgot Cooperative password.');
    const b = await readJson(request); checkNewPassword(b.password); const question = checkQuestion(b.question, b.answer);
    if (await sameAsLoginPassword(env, uid, b.password)) throw fail(400, SAME_PW);
    const pw = await makeSecret(b.password), an = await makeSecret(normAnswer(b.answer)), now = nowIso();
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO coop_auth (user_id, password_hash, salt, iterations, security_question, answer_hash, answer_salt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid, pw.hash, pw.salt, pw.iterations, question, an.hash, an.salt, now, now).run();
    if (!res.meta || res.meta.changes === 0) throw fail(409, 'A Cooperative password already exists.');
    return json({ ok: true }, 200, await startCoopSession(env, uid));
  }
  if (path === '/api/coop-auth/unlock' && method === 'POST') {
    const b = await readJson(request), key = 'coop:' + uid; await throttleCheck(env, key, 5);
    const c = await row(); if (!c) throw fail(409, 'Create a Cooperative password first.');
    if (!(await verifySecret(str(b.password), c.password_hash, c.salt, c.iterations))) { await throttleFail(env, key); throw fail(403, 'Wrong Cooperative password.'); }
    await throttleClear(env, key);
    return json({ ok: true }, 200, await startCoopSession(env, uid));
  }
  if (path === '/api/coop-auth/lock' && method === 'POST') {
    const token = cookieOf(request, COOP_COOKIE);
    if (/^[0-9a-f]{64}$/.test(token)) await env.DB.prepare('DELETE FROM coop_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': coopCookie('', true) });
  }
  if (path === '/api/coop-auth/reset/question' && method === 'POST') {
    const c = await row(); if (!c) throw fail(400, 'No Cooperative password has been created yet.');
    return json({ question: c.security_question });
  }
  if (path === '/api/coop-auth/reset' && method === 'POST') { // separate from the SweepTrack reset: uses the Cooperative security question
    const b = await readJson(request), key = 'coop-reset:' + uid; await throttleCheck(env, key, 5); checkNewPassword(b.new_password);
    const c = await row(); if (!c) throw fail(400, 'No Cooperative password has been created yet.');
    if (!(await verifyAnswer(c, b.answer))) { await throttleFail(env, key); throw fail(403, 'That answer is not correct.'); }
    if (await sameAsLoginPassword(env, uid, b.new_password)) throw fail(400, SAME_PW);
    const pw = await makeSecret(b.new_password);
    await env.DB.prepare('UPDATE coop_auth SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE user_id = ?').bind(pw.hash, pw.salt, pw.iterations, nowIso(), uid).run();
    await dropCoopSessions(env, uid); await throttleClear(env, key); await throttleClear(env, 'coop:' + uid);
    return json({ ok: true }, 200, { 'set-cookie': coopCookie('', true) });
  }
  return null;
}

// ---------- Waste Recyclers Cooperative ledger ----------
// Separate from customer collection records. Tables: coop_members, coop_payments, coop_withdrawals, coop_adjustments.
// Totals are always calculated from transactions; manual adjustments are stored on their own and added on top.
const TX = { payments: 'coop_payments', withdrawals: 'coop_withdrawals' };
const naira = (k) => '₦' + Math.floor(Math.abs(k) / 100).toLocaleString('en-NG') + (Math.abs(k) % 100 ? '.' + String(Math.abs(k) % 100).padStart(2, '0') : '');
function memberName(v) {
  const n = str(v).trim().replace(/\s+/g, ' ');
  if (!n || n.length > 120) throw fail(400, 'Enter the member name (up to 120 characters).');
  return n;
}
function parseWhen(v) {
  if (v == null || str(v).trim() === '') return null;
  const t = Date.parse(str(v));
  if (!Number.isFinite(t)) throw fail(400, 'Enter a valid date and time.');
  if (t > Date.now() + 24 * 3600 * 1000) throw fail(400, 'The date and time cannot be in the future.');
  return new Date(t).toISOString();
}
async function coopTotals(env) {
  const r = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_payments) AS paid_tx,
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_withdrawals) AS wd_tx,
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_adjustments WHERE kind = 'payments') AS paid_adj,
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_adjustments WHERE kind = 'withdrawals') AS wd_adj`).first();
  const paid_final = r.paid_tx + r.paid_adj, withdrawn_final = r.wd_tx + r.wd_adj;
  return { paid_tx: r.paid_tx, paid_adj: r.paid_adj, paid_final, withdrawn_tx: r.wd_tx, withdrawn_adj: r.wd_adj, withdrawn_final,
    balance_tx: r.paid_tx - r.wd_tx, balance_final: paid_final - withdrawn_final };
}
// Refuses a change that would leave the Cooperative totals or balance negative.
async function assertCoop(env, { paid = 0, withdrawn = 0 }) {
  const t = await coopTotals(env), p = t.paid_final + paid, w = t.withdrawn_final + withdrawn;
  if (p < 0) throw fail(409, 'This change would make the total paid negative.');
  if (w < 0) throw fail(409, 'This change would make the total withdrawn negative.');
  if (p - w < 0) throw fail(409, `This change would make the Cooperative balance negative (${naira(w - p)} short). Adjust or remove a manual adjustment first.`);
}
async function memberBalance(env, id, exclPayment = -1, exclWithdrawal = -1) {
  const r = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_payments WHERE member_id = ?1 AND id != ?2) -
    (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_withdrawals WHERE member_id = ?1 AND id != ?3) AS bal`).bind(id, exclPayment, exclWithdrawal).first();
  return r.bal;
}
const getMember = (env, id) => env.DB.prepare('SELECT * FROM coop_members WHERE id = ?').bind(id).first();
async function resolveMember(env, b, allowCreate) {
  if (b.member_id != null && str(b.member_id) !== '') {
    const m = await getMember(env, Number(b.member_id));
    if (!m) throw fail(404, 'That member was not found.');
    return m;
  }
  if (!allowCreate) throw fail(400, 'Select a member.');
  const name = memberName(b.member_name), now = nowIso();
  await env.DB.prepare('INSERT OR IGNORE INTO coop_members (name, created_at, updated_at) VALUES (?, ?, ?)').bind(name, now, now).run();
  return env.DB.prepare('SELECT * FROM coop_members WHERE name = ? COLLATE NOCASE').bind(name).first();
}
const txOut = (type, r) => ({ type, id: r.id, member_id: r.member_id, member_name: r.member_name, amount_kobo: r.amount_kobo, occurred_at: r.occurred_at, created_at: r.created_at, updated_at: r.updated_at });
function positiveAmount(v) {
  const a = parseNaira(v); if (a <= 0) throw fail(400, 'Enter an amount above zero.'); return a;
}

async function txCreate(env, kind, b) {
  const table = TX[kind], amount = positiveAmount(b.amount);
  const cid = /^[\w-]{8,64}$/.test(str(b.client_id)) ? b.client_id : crypto.randomUUID();
  const dup = await env.DB.prepare(`SELECT id FROM ${table} WHERE client_id = ?`).bind(cid).first(); // a repeated submit never doubles a payment
  if (dup) return dup.id;
  const member = await resolveMember(env, b, kind === 'payments'), now = nowIso(); // date and time are always set by the server
  if (kind === 'withdrawals') {
    const bal = await memberBalance(env, member.id);
    if (amount > bal) throw fail(409, `${member.name} has ${naira(bal)} available. A withdrawal cannot be more than the member's balance.`);
    await assertCoop(env, { withdrawn: amount });
    // guarded insert: only writes while the balance still covers the amount
    const res = await env.DB.prepare(`INSERT INTO coop_withdrawals (client_id, member_id, amount_kobo, occurred_at, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?4, ?4 WHERE (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_payments WHERE member_id = ?2) -
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_withdrawals WHERE member_id = ?2) >= ?3`).bind(cid, member.id, amount, now).run();
    if (!res.meta || res.meta.changes === 0) throw fail(409, 'The member balance changed. Please check it and try again.');
  } else {
    await assertCoop(env, { paid: amount });
    await env.DB.prepare('INSERT INTO coop_payments (client_id, member_id, amount_kobo, occurred_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4, ?4)').bind(cid, member.id, amount, now).run();
  }
  return (await env.DB.prepare(`SELECT id FROM ${table} WHERE client_id = ?`).bind(cid).first()).id;
}
async function txUpdate(env, kind, id, b) {
  const table = TX[kind], old = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  if (!old) throw fail(404, 'Transaction not found. It may already be deleted.');
  const amount = positiveAmount(b.amount), member = await resolveMember(env, { member_id: b.member_id ?? old.member_id }, false), when = parseWhen(b.occurred_at) || old.occurred_at;
  if (kind === 'payments') {
    // the old member loses this payment (and the new member gains it): nobody may end up below zero
    const rest = await memberBalance(env, old.member_id, id, -1);
    if (member.id === old.member_id ? rest + amount < 0 : rest < 0) throw fail(409, `This change would leave the previous member with a negative balance (${naira((member.id === old.member_id ? rest + amount : rest))}). Reduce their withdrawals first.`);
    await assertCoop(env, { paid: amount - old.amount_kobo });
    await env.DB.prepare('UPDATE coop_payments SET member_id = ?, amount_kobo = ?, occurred_at = ?, updated_at = ? WHERE id = ?').bind(member.id, amount, when, nowIso(), id).run();
  } else {
    const avail = await memberBalance(env, member.id, -1, id);
    if (amount > avail) throw fail(409, `${member.name} has ${naira(avail)} available. A withdrawal cannot be more than the member's balance.`);
    await assertCoop(env, { withdrawn: amount - old.amount_kobo });
    const res = await env.DB.prepare(`UPDATE coop_withdrawals SET member_id = ?1, amount_kobo = ?2, occurred_at = ?3, updated_at = ?4 WHERE id = ?5 AND
      (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_payments WHERE member_id = ?1) - (SELECT COALESCE(SUM(amount_kobo), 0) FROM coop_withdrawals WHERE member_id = ?1 AND id != ?5) >= ?2`)
      .bind(member.id, amount, when, nowIso(), id).run();
    if (!res.meta || res.meta.changes === 0) throw fail(409, 'The member balance changed. Please check it and try again.');
  }
}
async function txDelete(env, kind, id) {
  const table = TX[kind], old = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  if (!old) throw fail(404, 'Transaction not found. It may already be deleted.');
  if (kind === 'payments') {
    const rest = await memberBalance(env, old.member_id, id, -1);
    if (rest < 0) throw fail(409, `This payment cannot be deleted: the member's withdrawals would exceed their payments by ${naira(rest)}. Edit or delete their withdrawals first.`);
    await assertCoop(env, { paid: -old.amount_kobo });
  } else await assertCoop(env, { withdrawn: -old.amount_kobo });
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
}

function parseAdjustment(b) {
  const kind = str(b.kind); if (!TX[kind]) throw fail(400, 'Choose whether to adjust the total paid or the total withdrawn.');
  const direction = str(b.direction); if (direction !== 'increase' && direction !== 'decrease') throw fail(400, 'Choose increase or decrease.');
  const amount = positiveAmount(b.amount), reason = str(b.reason).trim();
  if (!reason || reason.length > 300) throw fail(400, 'Enter the reason for this adjustment (up to 300 characters).');
  return { kind, amount_kobo: direction === 'increase' ? amount : -amount, reason };
}
const adjDelta = (kind, v) => (kind === 'payments' ? { paid: v } : { withdrawn: v });

async function coopRoutes(path, method, request, env) {
  if (!path.startsWith('/api/coop/')) return null;
  const url = new URL(request.url);
  if (path === '/api/coop/overview' && method === 'GET') {
    const [members, adjustments, totals] = await Promise.all([
      env.DB.prepare(`SELECT m.id, m.name, COALESCE(p.total, 0) AS paid, COALESCE(w.total, 0) AS withdrawn, COALESCE(p.n, 0) + COALESCE(w.n, 0) AS tx_count
        FROM coop_members m
        LEFT JOIN (SELECT member_id, SUM(amount_kobo) AS total, COUNT(*) AS n FROM coop_payments GROUP BY member_id) p ON p.member_id = m.id
        LEFT JOIN (SELECT member_id, SUM(amount_kobo) AS total, COUNT(*) AS n FROM coop_withdrawals GROUP BY member_id) w ON w.member_id = m.id
        ORDER BY m.name COLLATE NOCASE`).all(),
      env.DB.prepare('SELECT * FROM coop_adjustments ORDER BY created_at DESC, id DESC').all(),
      coopTotals(env),
    ]);
    return json({
      members: members.results.map((m) => ({ id: m.id, name: m.name, paid_kobo: m.paid, withdrawn_kobo: m.withdrawn, balance_kobo: m.paid - m.withdrawn, tx_count: m.tx_count })),
      totals, adjustments: adjustments.results.map((a) => ({ id: a.id, kind: a.kind, amount_kobo: a.amount_kobo, reason: a.reason, created_at: a.created_at, updated_at: a.updated_at })),
    });
  }
  if (path === '/api/coop/transactions' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 20, 1), 200), mid = url.searchParams.get('member_id');
    const where = mid ? 'WHERE x.member_id = ?' : '';
    const sub = (type, table) => `SELECT '${type}' AS type, x.id, x.member_id, m.name AS member_name, x.amount_kobo, x.occurred_at, x.created_at, x.updated_at FROM ${table} x JOIN coop_members m ON m.id = x.member_id ${where}`;
    const args = mid ? [Number(mid), Number(mid)] : [];
    const { results } = await env.DB.prepare(`SELECT * FROM (${sub('payment', 'coop_payments')} UNION ALL ${sub('withdrawal', 'coop_withdrawals')}) ORDER BY occurred_at DESC, id DESC, type LIMIT ?`).bind(...args, limit + 1).all();
    return json({ transactions: results.slice(0, limit).map((r) => txOut(r.type, r)), has_more: results.length > limit });
  }
  if (path === '/api/coop/members' && method === 'POST') {
    const b = await readJson(request), name = memberName(b.name), now = nowIso();
    if (await env.DB.prepare('SELECT id FROM coop_members WHERE name = ? COLLATE NOCASE').bind(name).first()) throw fail(409, 'A member with that name already exists.');
    await env.DB.prepare('INSERT INTO coop_members (name, created_at, updated_at) VALUES (?, ?, ?)').bind(name, now, now).run();
    return json({ ok: true, member: await env.DB.prepare('SELECT id, name FROM coop_members WHERE name = ? COLLATE NOCASE').bind(name).first() }, 201);
  }
  let m = /^\/api\/coop\/members\/(\d+)$/.exec(path);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(m[1]);
    if (!(await getMember(env, id))) throw fail(404, 'Member not found.');
    if (method === 'PUT') {
      const name = memberName((await readJson(request)).name);
      const clash = await env.DB.prepare('SELECT id FROM coop_members WHERE name = ? COLLATE NOCASE AND id != ?').bind(name, id).first();
      if (clash) throw fail(409, 'A member with that name already exists.');
      await env.DB.prepare('UPDATE coop_members SET name = ?, updated_at = ? WHERE id = ?').bind(name, nowIso(), id).run();
      return json({ ok: true });
    }
    const n = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM coop_payments WHERE member_id = ?1) + (SELECT COUNT(*) FROM coop_withdrawals WHERE member_id = ?1) AS n').bind(id).first();
    if (n.n > 0) throw fail(409, 'This member has transactions. Delete or move their payments and withdrawals first.');
    await env.DB.prepare('DELETE FROM coop_members WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  m = /^\/api\/coop\/(payments|withdrawals)(?:\/(\d+))?$/.exec(path);
  if (m) {
    const kind = m[1], id = m[2] ? Number(m[2]) : null;
    if (!id && method === 'POST') { const newId = await txCreate(env, kind, await readJson(request)); return json({ ok: true, id: newId }, 201); }
    if (id && method === 'PUT') { await txUpdate(env, kind, id, await readJson(request)); return json({ ok: true }); }
    if (id && method === 'DELETE') { await txDelete(env, kind, id); return json({ ok: true }); }
  }
  m = /^\/api\/coop\/adjustments(?:\/(\d+))?$/.exec(path);
  if (m) {
    const id = m[1] ? Number(m[1]) : null;
    if (!id && method === 'POST') {
      const a = parseAdjustment(await readJson(request)); await assertCoop(env, adjDelta(a.kind, a.amount_kobo));
      const now = nowIso();
      await env.DB.prepare('INSERT INTO coop_adjustments (kind, amount_kobo, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(a.kind, a.amount_kobo, a.reason, now, now).run();
      return json({ ok: true }, 201);
    }
    if (id) {
      const old = await env.DB.prepare('SELECT * FROM coop_adjustments WHERE id = ?').bind(id).first();
      if (!old) throw fail(404, 'Adjustment not found. It may already be deleted.');
      if (method === 'PUT') {
        const a = parseAdjustment(await readJson(request));
        // remove the old effect and apply the new one in a single check
        const d = { paid: 0, withdrawn: 0 }; d[old.kind === 'payments' ? 'paid' : 'withdrawn'] -= old.amount_kobo; d[a.kind === 'payments' ? 'paid' : 'withdrawn'] += a.amount_kobo;
        await assertCoop(env, d);
        await env.DB.prepare('UPDATE coop_adjustments SET kind = ?, amount_kobo = ?, reason = ?, updated_at = ? WHERE id = ?').bind(a.kind, a.amount_kobo, a.reason, nowIso(), id).run();
        return json({ ok: true });
      }
      if (method === 'DELETE') { // removes only the adjustment, never the transactions
        await assertCoop(env, adjDelta(old.kind, -old.amount_kobo));
        await env.DB.prepare('DELETE FROM coop_adjustments WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }
    }
  }
  return null;
}

// ---------- Logistics: the organisation's own expenses, separate from customer collection records and from the Cooperative ledger ----------
const logisticsOut = (r) => ({ id: r.id, purpose: r.purpose, amount_kobo: r.amount_kobo, occurred_at: r.occurred_at, remark: r.remark || '', created_at: r.created_at, updated_at: r.updated_at });
function parseLogistics(b) {
  const purpose = str(b.purpose).trim().replace(/\s+/g, ' ');
  if (!purpose || purpose.length > 200) throw fail(400, 'Enter the item or purpose (up to 200 characters).');
  const amount_kobo = positiveAmount(b.amount), remark = str(b.remark).trim();
  if (remark.length > 300) throw fail(400, 'The remark is too long (300 characters at most).');
  return { purpose, amount_kobo, remark, occurred_at: parseWhen(b.occurred_at) };
}
async function logisticsRoutes(path, method, request, env) {
  if (path !== '/api/logistics' && !/^\/api\/logistics\/\d+$/.test(path)) return null;
  const url = new URL(request.url);
  if (path === '/api/logistics' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 20, 1), 200);
    const [rows, tot] = await Promise.all([
      env.DB.prepare('SELECT * FROM logistics ORDER BY occurred_at DESC, id DESC LIMIT ?').bind(limit + 1).all(),
      env.DB.prepare('SELECT COALESCE(SUM(amount_kobo), 0) AS total, COUNT(*) AS n FROM logistics').first(),
    ]);
    return json({ items: rows.results.slice(0, limit).map(logisticsOut), has_more: rows.results.length > limit, total_kobo: tot.total, count: tot.n });
  }
  if (path === '/api/logistics' && method === 'POST') {
    const b = await readJson(request), rec = parseLogistics(b), now = nowIso();
    const cid = /^[\w-]{8,64}$/.test(str(b.client_id)) ? b.client_id : crypto.randomUUID();
    const dup = await env.DB.prepare('SELECT id FROM logistics WHERE client_id = ?').bind(cid).first(); // a repeated tap never records twice
    if (dup) return json({ ok: true, id: dup.id }, 201);
    await env.DB.prepare('INSERT INTO logistics (client_id, purpose, amount_kobo, occurred_at, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(cid, rec.purpose, rec.amount_kobo, rec.occurred_at || now, rec.remark, now, now).run();
    return json({ ok: true, id: (await env.DB.prepare('SELECT id FROM logistics WHERE client_id = ?').bind(cid).first()).id }, 201);
  }
  const id = Number(/(\d+)$/.exec(path)[1]), old = await env.DB.prepare('SELECT * FROM logistics WHERE id = ?').bind(id).first();
  if (!old) throw fail(404, 'Logistics record not found. It may already be deleted.');
  if (method === 'PUT') {
    const rec = parseLogistics(await readJson(request));
    await env.DB.prepare('UPDATE logistics SET purpose = ?, amount_kobo = ?, occurred_at = ?, remark = ?, updated_at = ? WHERE id = ?')
      .bind(rec.purpose, rec.amount_kobo, rec.occurred_at || old.occurred_at, rec.remark, nowIso(), id).run();
    return json({ ok: true });
  }
  if (method === 'DELETE') { await env.DB.prepare('DELETE FROM logistics WHERE id = ?').bind(id).run(); return json({ ok: true }); }
  return null;
}

// ---------- CSV export ----------
function cell(v) {
  let s = v == null ? '' : String(v);
  // spreadsheet formula safety: text that starts like a formula is neutralised, plain phone numbers like +234... are left alone
  if (/^[=@\t\r]/.test(s) || (/^[+\-]/.test(s) && !/^[+\-]?[\d\s().\-/]+$/.test(s))) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function exportCsv(url, env) {
  const { where, args } = filters(url);
  const head = ['Date', 'Customer Name', 'Phone No', 'Account No', 'Bank Name', 'Address', 'Plastic Types', ...PLASTICS.map((p) => p + ' KG'), ...PLASTICS.map((p) => p + ' Price per KG (NGN)'), 'Total KG', 'Amount (NGN)', 'Price per KG (NGN, overall)', 'Remark', 'Created', 'Updated'];
  const lines = [head.map(cell).join(',')];
  let cursor = null;
  for (;;) {
    const w = [...where], a = [...args];
    if (cursor) { w.push('(date < ? OR (date = ? AND id < ?))'); a.push(cursor.date, cursor.date, cursor.id); }
    const { results } = await env.DB.prepare(`SELECT * FROM records ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT 500`).bind(...a).all();
    if (!results.length) break;
    for (const r of await attachItems(env, results)) {
      const by = Object.fromEntries(r.items.map((i) => [i.type, i.kg_milli])), prices = Object.fromEntries(r.items.map((i) => [i.type, i.rate_kobo])), rate = ratePerKg(r.kg_milli, r.amount_kobo);
      lines.push([r.date, r.customer_name, r.phone, r.account_no, r.bank_name, r.address, r.items.map((i) => i.type).join('; '),
        ...PLASTICS.map((p) => (by[p] != null ? fmtMilli(by[p]) : '')), ...PLASTICS.map((p) => (prices[p] != null ? fmtKobo(prices[p]) : '')), fmtMilli(r.kg_milli), fmtKobo(r.amount_kobo),
        rate == null ? '' : fmtKobo(rate), r.remark, r.created_at, r.updated_at].map(cell).join(','));
    }
    if (results.length < 500) break;
    cursor = { date: results[results.length - 1].date, id: results[results.length - 1].id };
  }
  return new Response('\uFEFF' + lines.join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="sweep-records-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}

// ---------- entry point ----------
async function handleApi({ request, env }) {
  try {
    if (!env.DB) throw fail(500, 'Database is not connected. Check the DB binding.');
    const path = new URL(request.url).pathname.replace(/\/+$/, ''), method = request.method;
    if (method !== 'GET' && request.headers.get('X-Requested-With') !== 'sweep') throw fail(403, 'Request blocked.');
    let res = await authRoutes(path, method, request, env);
    if (res) return res;
    const session = await getSession(env, request);
    if (!session) throw fail(401, 'Please sign in.');
    res = (await accountRoutes(path, method, request, env, session)) || (await recordRoutes(path, method, request, env)) || (await coopAuthRoutes(path, method, request, env, session));
    if (res) return res;
    if (path.startsWith('/api/coop/') && !(await coopAccess(env, request, session))) throw fail(403, 'The Cooperative is locked. Enter the Cooperative password.', 'coop_locked');
    res = (await coopRoutes(path, method, request, env)) || (await logisticsRoutes(path, method, request, env));
    if (res) return res;
    throw fail(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
    if (/no such table: (coop_|logistics)/.test(String(e && e.message))) return json({ error: 'The Cooperative and Logistics tables are missing. Run the SQL migration in the D1 console first.' }, 503);
    console.error('SweepTrack API error:', e && e.stack || e);
    return json({ error: 'Server error. Nothing was changed.' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return handleApi({ request, env });
    return env.ASSETS.fetch(request); // everything else is the normal static app
  },
};
