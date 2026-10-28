// Web OTA console — trang tĩnh trên GitHub Pages để xem / đổi bản web nào được phát.
//
// ĐỌC  : bản sao history.json (mọi bản web + native + nhật ký, không bao giờ cắt) trên
//        nhánh ota-mirror của repo release (contents API — asset của release không có
//        CORS nên trình duyệt không đọc thẳng được). App thì tải channel.json — CI sinh
//        từ history, cho cùng kết quả (ota_view.mjs :: deriveChannel / checkDerived).
// GHI  : không bao giờ ghi trực tiếp. Mỗi thao tác = workflow_dispatch web-ota.yml ở
//        repo code (token của người dùng chỉ cần quyền chạy workflow); workflow chạy
//        `web_ota.mjs <action>` bằng secret RELEASES_GITHUB_TOKEN — cùng code, cùng
//        cơ chế ghi lạc quan như CLI.
// XEM TRƯỚC: applyAction + servingOverview của ota_view.js (chép nguyên văn từ
//        lib/60_web_ota lúc build) → kết quả xem trước khớp với thứ workflow sẽ ghi.
import config from './config.js';
import { applyAction, planDiff, planText, rollbackRevokes, servingOverview, ungroupedBuilds, versionGroups } from './ota_view.js';

const API = 'https://api.github.com';
const COLORS = 6;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Lưu tạm trong trình duyệt (tiện cho người xem; có thể bị chặn) ──────────
const store = {
  get(k) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  set(k, v, persist = true) {
    try {
      (persist ? localStorage : sessionStorage).setItem(k, v);
      if (!persist) localStorage.removeItem(k);
    } catch { /* storage blocked */ }
  },
  del(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { /* noop */ } },
};

const params = new URLSearchParams(location.search);
const state = {
  // Mỗi nhánh một trang, một env (stg: apps/talk-x → talkx-releases, prod: apps/talk-x-prod → talkx-prod-releases).
  env: config.env,
  token: store.get('webota.token'),
  user: null,
  channel: null,
  missing: false,
  liveAssetId: null,
  activityShown: 30,
  expanded: new Set(),
  runs: [],
  loading: false,
  error: null,
  loadedAt: 0,
  colors: new Map(),
  openVersions: new Map(),
  workflowMissing: false,
};
// Thử cục bộ: http://localhost:<port>/?channel=./sample.json đọc file đó thay bản sao.
const devChannel = ['localhost', '127.0.0.1'].includes(location.hostname) ? params.get('channel') : null;

const envCfg = () => config;

// ── DOM ─────────────────────────────────────────────────────────────────────
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ext = (href, text, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls, text });
const ghUrl = (repo, ...parts) => `https://github.com/${repo}/${parts.map((p) => encodeURIComponent(p)).join('/')}`;
const shortSha = (s) => (/^[0-9a-f]{7,40}$/.test(String(s)) ? String(s).slice(0, 7) : null);

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d < 60 ? `${d} days ago` : new Date(t).toISOString().slice(0, 10);
}
const fullTime = (iso) => { const t = Date.parse(iso); return t ? new Date(t).toLocaleString() : ''; };

let toastTimer = null;
function toast(text, kind = '') {
  let el = $('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 6000);
}

// ── GitHub API ──────────────────────────────────────────────────────────────
// Không gửi header tự đặt khi không có token → GET đơn giản, không cần preflight.
async function api(method, path, { body, accept, auth = true } = {}) {
  const headers = { Accept: accept || 'application/vnd.github+json' };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch (e) {
    throw new Error(`Could not reach api.github.com (${e.message}).`);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(text).message || ''; } catch { msg = text.slice(0, 200); }
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const err = new Error(`GitHub API rate limit reached${state.token ? '' : ' (60 requests an hour without a token)'}. ${reset ? `It resets at ${new Date(reset).toLocaleTimeString()}.` : ''}${state.token ? '' : ' Connect a token to raise it.'}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 401) {
      const err = new Error('GitHub rejected the token (401). It may have expired — connect a new one.');
      err.status = 401;
      throw err;
    }
    const err = new Error(`${method} ${path} → HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return {};
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

async function fetchMirror(repo) {
  if (devChannel) {
    const res = await fetch(devChannel, { cache: 'no-store' });
    if (!res.ok) throw new Error(`dev channel ${devChannel} → HTTP ${res.status}`);
    return res.json();
  }
  const raw = await api('GET', `/repos/${repo}/contents/${config.mirror.path}?ref=${encodeURIComponent(config.mirror.branch)}`, { accept: 'application/vnd.github.raw' });
  if (raw == null) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function load() {
  const repo = envCfg().releasesRepo;
  state.loading = true;
  renderSync();
  try {
    const [history, release] = await Promise.all([fetchMirror(repo), api('GET', `/repos/${repo}/releases/tags/web-ota`)]);
    if (history && !Array.isArray(history.events)) history.events = [];
    state.channel = history;
    state.missing = history == null;
    state.liveAssetId = (release?.assets || []).find((a) => a.name === config.mirror.path)?.id ?? null;
    state.error = null;
    state.loadedAt = Date.now();
  } catch (e) {
    state.error = e.message;
    if (e.status === 401) disconnect(false);
  } finally {
    state.loading = false;
  }
  await loadRuns();
  render();
}

async function loadRuns() {
  if (!state.token) { state.runs = []; state.workflowMissing = false; return; }
  try {
    const r = await api('GET', `/repos/${config.codeRepo}/actions/workflows/${config.workflow}/runs?per_page=10`);
    // 404 với token đã thấy được repo = GitHub không còn biết workflow (nằm ngoài main
    // và mọi run của nó đã bị xoá) → không bấm được gì, báo đúng nguyên nhân.
    state.workflowMissing = r == null;
    state.runs = (r?.workflow_runs || []).filter((x) => x.head_branch === config.ref).slice(0, 5);
  } catch {
    state.runs = [];
  }
}

// ── Màu từng bản web trên bảng phát (ổn định trong một lần vẽ) ──────────────
function assignColors(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows) {
      for (const s of r.plan) {
        if (s.target && s.target !== 'builtin' && !map.has(s.target)) map.set(s.target, map.size % COLORS);
      }
    }
  }
  return map;
}
const cellClass = (target, colors) => (target === 'builtin' ? 'builtin' : target == null ? 'none' : colors.has(target) ? `c${colors.get(target)}` : 'none');

function strip(plan, colors, compact = false) {
  const el = h('div', { class: `strip${compact ? ' compact' : ''}`, role: 'img', 'aria-label': planText(plan) });
  for (const s of plan) {
    for (let i = s.from; i <= s.to; i++) el.append(h('span', { class: `cell ${cellClass(s.target, colors)}`, title: `${i}% → ${s.target ?? 'unchanged'}` }));
  }
  return el;
}

const platformName = (p) => (p === 'ios' ? 'iOS' : p === 'android' ? 'Android' : p);

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  renderEnv();
  renderAccount();
  renderSync();
  renderNotices();
  renderVersions();
  renderActivity();
  renderFoot();
}

function renderEnv() {
  const el = $('env');
  el.textContent = state.env;
  el.className = `env-badge ${state.env}`;
  el.title = `${config.releasesRepo} · branch ${config.ref}${config.enabled ? '' : ' · Web OTA off'}`;
}

function renderAccount() {
  const box = $('account');
  if (state.token && state.user) {
    box.replaceChildren(h('span', { class: 'account' },
      state.user.avatar_url?.startsWith('https://avatars.githubusercontent.com/') ? h('img', { src: state.user.avatar_url, alt: '' }) : null,
      `@${state.user.login}`,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => disconnect(true), text: 'Disconnect' })));
  } else {
    box.replaceChildren(h('button', { class: 'btn primary small', type: 'button', onclick: openTokenDialog, text: 'Connect GitHub' }));
  }
}

function renderSync() {
  const el = $('sync-state');
  if (state.loading) { el.textContent = 'Loading…'; return; }
  if (!state.channel) { el.textContent = ''; return; }
  el.textContent = `Changed ${ago(state.channel.updatedAt)}`;
  el.title = `history rev ${state.channel.rev ?? '?'} · ${fullTime(state.channel.updatedAt)}`;
}

function notice(kind, text, ...actions) {
  return h('div', { class: `notice ${kind}` }, h('p', {}, text), ...actions);
}

function renderNotices() {
  const list = [];
  const cfg = envCfg();
  if (state.error) list.push(notice('error', state.error, h('button', { class: 'btn small', type: 'button', onclick: load, text: 'Try again' })));
  if (!cfg.enabled) list.push(notice('warn', `Web OTA is off for ${state.env} (WEB_OTA_ENABLED=false in mobile.config.sh). Nothing here reaches an app until it is turned on.`));
  if (devChannel) list.push(notice('warn', `Local test: showing ${devChannel} instead of the mirror. Changes still run the real workflow.`));
  if (!state.token) list.push(notice('', 'Read-only. Connect a GitHub token to pause, revoke or roll out builds.', h('button', { class: 'btn small', type: 'button', onclick: openTokenDialog, text: 'Connect GitHub' })));
  if (state.token && state.workflowMissing) {
    list.push(notice('error', `Changes are unavailable: GitHub does not know ${config.workflow} right now. It lives on ${config.ref} (not the default branch) and all of its runs were deleted. Push any change to .github/workflows/${config.workflow} on ${config.ref} to register it again, and do not delete all of its runs. Your token is fine.`));
  }
  if (!devChannel && state.channel && state.liveAssetId != null && state.channel.mirror?.assetId !== state.liveAssetId) {
    list.push(notice('warn', 'This page is behind: CI changed the release history but could not update the copy this page reads. What you see may be out of date.',
      h('button', { class: 'btn small', type: 'button', disabled: !state.token, onclick: () => openActionDialog('mirror'), text: 'Sync now' })));
  }
  $('notices').replaceChildren(...list);
}

function renderVersions() {
  const box = $('versions');
  const others = $('others');
  others.hidden = true;
  if (state.missing) {
    box.replaceChildren(h('div', { class: 'panel empty' },
      h('p', { text: `No release history for ${state.env} on this page yet. CI creates it at the next publish or app build, or create it now from the current channel.json (nothing changes for the apps).` }),
      h('button', { class: 'btn', type: 'button', disabled: !state.token, onclick: () => openActionDialog('mirror'), text: 'Sync now' })));
    return;
  }
  if (!state.channel) { box.replaceChildren(); return; }
  const groups = versionGroups(state.channel);
  state.colors = assignColors([groups.flatMap((g) => g.natives)]);
  if (!groups.length) {
    box.replaceChildren(h('div', { class: 'panel empty' }, h('p', { text: 'No app version is registered yet. Each store build registers itself after it is uploaded.' })));
  } else {
    // Mở sẵn 3 phiên bản mới nhất; người xem tự mở / đóng được (nhớ trong phiên). Chỉ
    // hiện 6 phiên bản mới nhất — nhiều năm sau có hàng trăm, phần còn lại sau một nút.
    const shown = state.expanded.has('versions') ? groups : groups.slice(0, VERSIONS_SHOWN);
    box.replaceChildren(...shown.map((g, i) => versionBlock(g, state.openVersions.get(g.appVersion) ?? i < 3)));
    if (shown.length < groups.length) {
      const older = groups.length - shown.length;
      box.append(h('button', {
        class: 'btn', type: 'button', text: `Show ${older} older app version${older === 1 ? '' : 's'}`,
        onclick: () => { state.expanded.add('versions'); renderVersions(); },
      }));
    }
  }
  const rest = ungroupedBuilds(state.channel, groups);
  if (rest.length) {
    others.hidden = false;
    const summary = h('summary', {}, h('span', { class: 'v-name small', text: `Older web builds (${rest.length})` }),
      h('span', { class: 'muted', text: 'Older than the web inside every registered app version — never served, kept as history.' }));
    others.replaceChildren(summary);
    // Chỉ vẽ khi mở (lịch sử nhiều năm = hàng nghìn dòng).
    const fill = () => { if (others.childElementCount === 1) others.append(buildTable(rest.map((b) => ({ build: b, per: [] })), null, 'others')); };
    others.ontoggle = () => { if (others.open) fill(); };
    if (others.open) fill();
  }
}

// Một khối = một phiên bản app (Android + iOS cùng APP_VERSION).
function versionBlock(g, open) {
  const nativesText = g.natives.map((n) => `${platformName(n.platform)} ${n.nativeBuild}`).join(' · ');
  // Native có cùng kế hoạch phát (thường là cả hai nền tảng) → chung một dải.
  const routes = new Map();
  for (const n of g.natives) {
    const k = planText(n.plan);
    if (!routes.has(k)) routes.set(k, { plan: n.plan, who: [] });
    routes.get(k).who.push(`${platformName(n.platform)} ${n.nativeBuild}`);
  }
  const det = h('details', { class: 'panel version', open: open || null });
  const gets = [...routes.values()].map((r) => h('span', { class: 'v-gets' }, routes.size > 1 ? h('span', { class: 'muted', text: `${r.who.join(' + ')}:` }) : null, planTargets(r.plan)));
  det.append(
    h('summary', {},
      h('span', { class: 'v-name', text: `v${g.appVersion}` }),
      h('span', { class: 'v-natives muted', text: nativesText }),
      h('span', { class: 'v-summary' }, gets)));
  // Thân khối chỉ dựng khi mở: phiên bản cũ có thể có hàng trăm bản web phía trên.
  let filled = false;
  const fill = () => { if (!filled) { filled = true; det.append(...versionBody(g, routes)); } };
  det.addEventListener('toggle', () => { state.openVersions.set(g.appVersion, det.open); if (det.open) fill(); });
  if (open) fill();
  return det;
}

function versionBody(g, routes) {
  return [
    h('div', { class: 'routes' }, [...routes.values()].map((r) => h('div', { class: 'route' },
      h('div', { class: 'route-label' }, h('span', { class: 'platform', text: 'Gets now' }), h('b', { text: r.who.join(' + ') })),
      strip(r.plan, state.colors),
      h('div', { class: 'route-gets mono', 'aria-label': planText(r.plan) }, r.plan.map((x) => h('span', {},
        h('span', { class: `swatch ${cellClass(x.target, state.colors)}` }),
        x.target === 'builtin' ? 'web inside the app' : x.target == null ? 'unchanged' : x.target,
        r.plan.length > 1 ? h('span', { class: 'pct', text: `${x.percent}%` }) : null)))))),
    g.builds.length
      ? buildTable(g.builds, g, `v${g.appVersion}`, builtinRows(g))
      : h('p', { class: 'muted pad', text: 'No web build newer than the one inside this app yet.' }),
  ];
}

function planTargets(plan) {
  return plan.map((x) => h('span', { class: 'v-target' },
    h('span', { class: `swatch ${cellClass(x.target, state.colors)}` }),
    h('span', { class: 'mono', text: x.target === 'builtin' ? 'web inside the app' : x.target == null ? 'unchanged' : x.target }),
    plan.length > 1 ? h('span', { class: 'muted', text: `${x.percent}%` }) : null));
}

const STATUS_LABEL = { approved: 'Approved', paused: 'Paused', pending: 'Pending', revoked: 'Revoked' };

function actionsFor(b) {
  const list = [];
  const can = Boolean(state.token) && envCfg().enabled && !state.workflowMissing;
  if (b.status === 'approved') list.push(['pause', 'Pause'], ['rollout', 'Rollout…'], ['revoke', 'Revoke']);
  if (b.status === 'paused') list.push(['resume', 'Resume'], ['rollout', 'Rollout…'], ['revoke', 'Revoke']);
  if (b.status === 'pending') list.push(['approve', 'Approve'], ['revoke', 'Revoke']);
  if (b.status === 'revoked') list.push(['restore', 'Restore']);
  if (b.status !== 'revoked' && rollbackRevokes(state.channel, b.buildId).length) list.push(['rollback-to', 'Roll back to this']);
  return list.map(([key, label]) => h('button', {
    class: 'btn small', type: 'button', disabled: !can,
    title: can ? null : !state.token ? 'Connect GitHub to make changes' : state.workflowMissing ? `${config.workflow} is not registered on GitHub` : `Web OTA is off for ${state.env}`,
    onclick: () => openActionDialog(key, b),
  }, label));
}

// Bảng bản web: 20 bản mới nhất, phần còn lại sau nút "Show all" (nhớ theo `key` để lần
// tự làm mới 30 giây không gập lại). `tail` = các dòng luôn ở cuối (web gốc trong app).
const PAGE = 20;
const VERSIONS_SHOWN = 6;
function buildTable(items, group, key, tail = []) {
  const head = h('div', { class: 'row head', role: 'row' },
    h('span', { role: 'columnheader', text: 'Status' }), h('span', { role: 'columnheader', text: 'Web build' }),
    h('span', { role: 'columnheader', text: 'Published' }), h('span', { role: 'columnheader', text: 'Rollout' }),
    h('span', { role: 'columnheader', class: 'actions', text: '' }));
  const table = h('div', { class: 'builds', role: 'table', 'aria-label': group ? `Web builds for v${group.appVersion}` : 'Older web builds' }, head);
  const all = state.expanded.has(key);
  table.append(...items.slice(0, all ? items.length : PAGE).map((x) => buildRow(x.build, x.per)));
  if (!all && items.length > PAGE) {
    const more = h('div', { class: 'row more', role: 'row' }, h('button', {
      class: 'btn small', type: 'button',
      onclick: () => {
        state.expanded.add(key);
        more.replaceWith(...items.slice(PAGE).map((x) => buildRow(x.build, x.per)));
      },
    }, `Show all ${items.length} web builds (${items.length - PAGE} older)`));
    table.append(more);
  }
  table.append(...tail);
  return table;
}

// Một bản web trong khối của một phiên bản app. `per` = từng native của phiên bản đó:
// chạy được không / vì sao / % thiết bị đang nhận.
function buildRow(b, per) {
  const repo = envCfg().releasesRepo;
  const sha = shortSha(b.commit);
  const roll = b.rollout ?? 100;
  const color = state.colors.has(b.buildId) ? `c${state.colors.get(b.buildId)}` : 'none';
  const sub = [
    b.webVersion ? `web ${b.webVersion}` : null,
    sha ? ext(`https://github.com/${config.codeRepo}/commit/${sha}`, sha, 'mono') : null,
    b.size ? `${(b.size / 1048576).toFixed(1)} MB` : null,
  ].filter(Boolean);
  const subEl = h('div', { class: 'build-sub' });
  sub.forEach((x, i) => { if (i) subEl.append(' · '); subEl.append(x); });

  // Đang nhận: "Serving 100%" khi mọi native như nhau, không thì từng nền tảng.
  const serving = per.filter((x) => x.serving > 0);
  let servingEl = null;
  if (serving.length) {
    const same = serving.length === per.length && serving.every((x) => x.serving === serving[0].serving);
    servingEl = h('span', { class: 'serving', text: same ? `Serving ${serving[0].serving}%` : `Serving ${serving.map((x) => `${platformName(x.platform)} ${x.serving}%`).join(' · ')}` });
  }
  // Không chạy được trên (một phần) phiên bản này: nói rõ vì sao.
  const blocked = per.filter((x) => !x.fits);
  let blockedEl = null;
  if (blocked.length) {
    const why = [...new Set(blocked.map((x) => x.why))];
    blockedEl = h('div', { class: 'blocked' },
      blocked.length === per.length ? "Can't run on this version: " : `Not on ${blocked.map((x) => platformName(x.platform)).join(', ')}: `,
      why.join('; '));
  }
  const allBlocked = per.length > 0 && blocked.length === per.length;
  return h('div', { class: `row is-${b.status}${allBlocked ? ' is-blocked' : ''}`, role: 'row' },
    h('div', { class: 'c-status', role: 'cell' },
      h('span', { class: `status ${b.status}`, text: STATUS_LABEL[b.status] || b.status }),
      b.status === 'paused' ? h('div', { class: 'build-sub', text: 'Kept where installed' }) : null),
    h('div', { class: 'c-build', role: 'cell' },
      h('div', { class: 'build-id' },
        h('span', { class: `swatch ${color}`, title: color === 'none' ? 'Not served to any app build right now' : 'Colour on the strips' }),
        ext(ghUrl(repo, 'releases', 'tag', b.buildId), b.buildId, 'mono'),
        servingEl),
      subEl,
      blockedEl),
    h('div', { class: 'c-created created', role: 'cell', title: fullTime(b.createdAt), text: ago(b.createdAt) }),
    h('div', { class: `c-rollout rollout${roll < 100 ? ' partial' : ''}`, role: 'cell', text: `${roll}%` }),
    h('div', { class: 'actions', role: 'cell' }, actionsFor(b)));
}

// Dòng "web gốc trong app" cuối mỗi khối (mỗi commit một dòng — Android / iOS thường chung).
function builtinRows(g) {
  const byCommit = new Map();
  for (const n of g.natives) {
    const k = n.commit || '?';
    if (!byCommit.has(k)) byCommit.set(k, { commit: n.commit, builtAt: n.builtAt, natives: [] });
    byCommit.get(k).natives.push(n);
  }
  return [...byCommit.values()].map((x) => {
    const sha = shortSha(x.commit);
    const pct = x.natives.map((n) => n.plan.filter((s) => s.target === 'builtin').reduce((sum, s) => sum + s.percent, 0));
    const subEl = h('div', { class: 'build-sub' }, 'Shipped in the store build',
      byCommit.size > 1 ? ` (${x.natives.map((n) => platformName(n.platform)).join(', ')})` : '',
      sha ? [' · ', ext(`https://github.com/${config.codeRepo}/commit/${sha}`, sha, 'mono')] : '');
    return h('div', { class: 'row builtin-row', role: 'row' },
      h('div', { class: 'c-status', role: 'cell' }, h('span', { class: 'status builtin', text: 'Built-in' })),
      h('div', { class: 'c-build', role: 'cell' },
        h('div', { class: 'build-id' }, h('span', { class: 'swatch builtin' }), h('span', { text: 'Web inside the app' }),
          pct.some((p) => p > 0) ? h('span', { class: 'serving', text: `Serving ${Math.max(...pct)}%` }) : null),
        subEl),
      h('div', { class: 'c-created created', role: 'cell', title: fullTime(x.builtAt), text: ago(x.builtAt) }),
      h('div', { class: 'c-rollout rollout', role: 'cell', text: '—' }),
      h('div', { class: 'actions', role: 'cell' }));
  });
}

function renderActivity() {
  const runsBox = $('runs');
  runsBox.replaceChildren(...state.runs
    .filter((r) => r.status !== 'completed' || Date.now() - Date.parse(r.updated_at) < 30 * 60_000)
    .map((r) => {
      const kind = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'success' : 'failure';
      const label = r.status !== 'completed' ? (r.status === 'in_progress' ? 'Running' : 'Queued') : r.conclusion === 'success' ? 'Done' : 'Failed';
      return h('div', { class: `run ${kind}` }, h('span', { class: 'dot' }),
        h('span', { text: `${label}: ${String(r.display_title || '').replace(/\s*\[[a-z0-9]+\]\s*$/, '')}` }),
        h('span', { class: 'muted', text: `@${r.actor?.login || '?'} · ${ago(r.created_at)}` }),
        ext(r.html_url, 'Log'));
    }));
  const list = $('activity');
  const events = state.channel?.events || [];
  if (!events.length) {
    list.replaceChildren(h('li', { class: 'none', text: state.missing ? 'No history yet.' : 'History appears here after the first change.' }));
    return;
  }
  const shown = events.slice(-state.activityShown).reverse();
  list.replaceChildren(...shown.map((e) => h('li', {},
    h('time', { datetime: e.at, title: fullTime(e.at), text: ago(e.at) }),
    h('span', { class: 'what' }, eventText(e), e.note ? h('span', { class: 'muted', text: ` — ${e.note}` }) : null,
      h('span', { class: 'muted', text: ` · @${e.actor || '?'}` })),
    h('span', { class: 'actions' }, /^https:\/\/github\.com\//.test(String(e.run || '')) ? ext(e.run, 'Log') : null))));
  if (events.length > shown.length) {
    list.append(h('li', { class: 'none' }, h('button', {
      class: 'btn small', type: 'button', text: `Show older (${events.length - shown.length} more)`,
      onclick: () => { state.activityShown += 100; renderActivity(); },
    })));
  }
}

// Một dòng nhật ký: cùng động từ với nút trên trang (Pause → "Paused").
function eventText(e) {
  const id = e.buildId ? h('span', { class: 'mono', text: e.buildId }) : '';
  switch (e.type) {
    case 'import': return 'Release history started (imported from channel.json)';
    case 'publish': return ['Published ', id, e.to && e.to !== 'approved' ? ` (${e.to})` : ''];
    case 'register': return `Registered ${platformName(e.platform)} build ${e.nativeBuild} (v${e.appVersion})`;
    case 'rollout': return ['Rollout of ', id, `: ${e.from}% → ${e.to}%`];
    case 'status': {
      const verb = e.to === 'paused' ? 'Paused' : e.to === 'revoked' ? 'Revoked' : e.to === 'pending' ? 'Set to pending'
        : e.from === 'paused' ? 'Resumed' : e.from === 'revoked' ? 'Restored' : 'Approved';
      return [`${verb} `, id];
    }
    default: return [String(e.type || 'change'), e.buildId ? ' ' : '', id];
  }
}

function renderFoot() {
  const cfg = envCfg();
  $('foot').replaceChildren(
    'Reads ', ext(ghUrl(cfg.releasesRepo, 'blob', config.mirror.branch, config.mirror.path), `${cfg.releasesRepo}@${config.mirror.branch}`),
    ' · changes run ', h('span', { class: 'mono', text: config.workflow }), ` in ${config.codeRepo} (${config.ref})`,
    ` · console built ${ago(config.builtAt)}`);
}

// ── Thao tác ────────────────────────────────────────────────────────────────
// key giao diện → lệnh CLI (approve / restore đều là promote).
const ACTION_UI = {
  pause: { cli: 'pause', title: 'Pause', verb: 'Pause build', done: 'Paused', cls: 'warn',
    effect: 'Stop serving this build to new devices and to devices on other builds. Devices already running it keep it; nobody is rolled back.' },
  resume: { cli: 'resume', title: 'Resume', verb: 'Resume build', done: 'Resumed', cls: 'go',
    effect: 'Serve this build again to every app build it supports, within its rollout.' },
  approve: { cli: 'promote', title: 'Approve', verb: 'Approve build', done: 'Approved', cls: 'go',
    effect: 'Start serving this build to every app build it supports, within its rollout.' },
  restore: { cli: 'promote', title: 'Restore', verb: 'Restore build', done: 'Restored', cls: 'primary',
    effect: 'Serve this revoked build again. Do this only if it was revoked by mistake.' },
  revoke: { cli: 'revoke', title: 'Revoke', verb: 'Revoke build', done: 'Revoked', cls: 'danger',
    effect: 'Never serve this build again. Devices running it move to the newest older approved build at their next check.' },
  rollout: { cli: 'rollout', title: 'Change rollout of', verb: 'Set rollout', done: 'Rollout set', cls: 'primary',
    effect: 'Serve this build to only this share of devices. Devices outside it get the newest older approved build, so lowering the number moves those devices back.' },
  'rollback-to': { cli: 'rollback-to', title: 'Roll back to', verb: 'Roll back', done: 'Rolled back', cls: 'danger',
    effect: 'Revoke every served build newer than this one and serve this one. Pending builds are left as they are.' },
  mirror: { cli: 'mirror', title: 'Sync the page copy', verb: 'Sync now', done: 'Synced', cls: 'primary',
    effect: 'Copy the current channel.json to the branch this page reads. Nothing changes for any app.' },
};

function impactView(op) {
  let next;
  try {
    next = applyAction(structuredClone(state.channel), op);
  } catch (e) {
    return { error: e.message };
  }
  const before = servingOverview(state.channel, { perPlatform: 100 });
  const after = servingOverview(next, { perPlatform: 100 });
  const colors = assignColors([before, after]);
  const diff = planDiff(before, after);
  const box = h('div', { class: 'impact' }, h('h4', { text: 'What changes for installed apps' }));
  if (!diff.length) {
    box.append(h('p', { class: 'impact-text', text: 'No app build changes what it gets.' }));
  }
  // Gộp các native đổi giống hệt nhau (thường là tất cả) thành một dòng.
  const groups = new Map();
  for (const d of diff) {
    const k = `${d.before}|${d.after}`;
    if (!groups.has(k)) groups.set(k, { ...d, who: [] });
    groups.get(k).who.push(`v${d.appVersion} ${platformName(d.platform)} ${d.nativeBuild}`);
  }
  for (const g of groups.values()) {
    const b = before.find((r) => r.platform === g.platform && r.nativeBuild === g.nativeBuild);
    const a = after.find((r) => r.platform === g.platform && r.nativeBuild === g.nativeBuild);
    box.append(h('div', { class: 'impact-row' },
      h('span', { class: 'who', text: g.who.join(', ') }),
      h('div', { class: 'impact-line' }, 'Now', strip(b.plan, colors, true)),
      h('div', { class: 'impact-line' }, 'After', strip(a.plan, colors, true)),
      h('span', { class: 'impact-text mono', text: `${g.before} → ${g.after}` })));
  }
  if (op.action === 'pause') box.append(h('p', { class: 'impact-text muted', text: 'Devices already running this build keep it — they are not shown above.' }));
  return { el: box };
}

let running = null;

function openActionDialog(key, build) {
  const ui = ACTION_UI[key];
  const dlg = $('action-dialog');
  const op = { action: ui.cli, buildId: build?.buildId, percent: build ? String(build.rollout ?? 100) : '' };
  const impactBox = h('div');
  const errorBox = h('p', { class: 'error', role: 'alert' });
  const submitBtn = h('button', { class: `btn ${ui.cls}`, type: 'submit', text: ui.verb });
  const refresh = () => {
    if (key === 'mirror') return;
    const r = impactView(op);
    impactBox.replaceChildren(r.el || '');
    errorBox.textContent = r.error || '';
    submitBtn.disabled = Boolean(r.error) || !state.token;
  };

  const fields = [];
  if (key === 'rollout') {
    const range = h('input', { type: 'range', min: '0', max: '100', step: '1', value: op.percent, 'aria-label': 'Rollout percent' });
    const num = h('input', { type: 'number', min: '0', max: '100', step: '1', value: op.percent, 'aria-label': 'Rollout percent' });
    const sync = (v) => { op.percent = String(v); range.value = v; num.value = v; refresh(); };
    range.addEventListener('input', () => sync(range.value));
    num.addEventListener('input', () => { if (num.value !== '') sync(Math.max(0, Math.min(100, Math.round(Number(num.value))))); });
    fields.push(h('label', {}, 'Share of devices (%)', h('div', { class: 'rollout-input' }, range, num)));
  }
  if (key === 'rollback-to') {
    const ids = rollbackRevokes(state.channel, build.buildId);
    fields.push(h('div', {}, h('p', { text: `Revokes ${ids.length} build${ids.length === 1 ? '' : 's'}:` }), h('ul', {}, ids.map((id) => h('li', { class: 'mono', text: id })))));
  }
  const note = h('textarea', { maxlength: '200', placeholder: key === 'mirror' ? '' : 'e.g. crash on login screen' });
  const progress = h('div', { class: 'progress', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() });

  const form = h('form', { method: 'dialog' },
    h('h3', { id: 'action-title' }, ui.title, build ? ' ' : '', build ? h('span', { class: 'mono', text: build.buildId }) : null),
    h('p', { text: ui.effect }),
    !envCfg().enabled ? h('p', { class: 'error', text: `Web OTA is off for ${state.env}.` }) : null,
    ...fields,
    impactBox,
    key === 'mirror' ? null : h('label', {}, 'Note (optional, kept in the activity log)', note),
    errorBox,
    progress,
    h('div', { class: 'buttons' }, cancel, submitBtn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (running) return;
    submitBtn.disabled = true;
    cancel.textContent = 'Close';
    errorBox.textContent = '';
    try {
      running = runAction(op, note.value.trim(), progress, ui);
      await running;
      toast(`${ui.done}${op.buildId ? ` ${op.buildId}` : ''}.`);
      dlg.close();
    } catch (e) {
      errorBox.textContent = e.message;
      submitBtn.disabled = false;
      load();
    } finally {
      running = null;
    }
  });
  dlg.replaceChildren(form);
  refresh();
  if (!state.token) submitBtn.disabled = true;
  dlg.showModal();
}

function setSteps(box, steps) {
  box.replaceChildren(...steps.map(([label, st, link]) => h('div', { class: `step ${st}` }, label, link ? ' · ' : '', link ? ext(link, 'Log') : null)));
}

async function runAction(op, note, progress, ui) {
  const requestId = Math.random().toString(36).slice(2, 10);
  const steps = [['Start the job', 'active'], ['Wait for a runner', ''], ['Update channel.json', ''], ['Reload', '']];
  setSteps(progress, steps);
  await api('POST', `/repos/${config.codeRepo}/actions/workflows/${config.workflow}/dispatches`, {
    body: {
      ref: config.ref,
      inputs: { action: op.action, build_id: op.buildId || '', percent: op.action === 'rollout' ? String(op.percent) : '', note, request_id: requestId },
    },
  });
  steps[0][1] = 'done'; steps[1][1] = 'active';
  setSteps(progress, steps);

  const t0 = Date.now();
  let run = null;
  while (!run) {
    if (Date.now() - t0 > 120_000) throw new Error('The job did not start within 2 minutes. Check the Actions tab of the code repo.');
    await sleep(2500);
    const r = await api('GET', `/repos/${config.codeRepo}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=20`);
    run = (r?.workflow_runs || []).find((x) => String(x.display_title || '').includes(`[${requestId}]`)) || null;
  }
  while (run.status !== 'completed') {
    if (run.status === 'in_progress' && steps[2][1] !== 'active') {
      steps[1][1] = 'done'; steps[2][1] = 'active'; steps[2][2] = run.html_url;
      setSteps(progress, steps);
    }
    if (Date.now() - t0 > 15 * 60_000) throw new Error('The job is still running after 15 minutes. Follow it in its log.');
    await sleep(3000);
    run = (await api('GET', `/repos/${config.codeRepo}/actions/runs/${run.id}`)) || run;
  }
  steps[1][1] = 'done'; steps[2][2] = run.html_url;
  if (run.conclusion !== 'success') {
    steps[2][1] = 'failed';
    setSteps(progress, steps);
    throw new Error(`${ui.verb} failed (${run.conclusion}). Open the log for the reason.`);
  }
  steps[2][1] = 'done'; steps[3][1] = 'active';
  setSteps(progress, steps);
  await load();
  steps[3][1] = 'done';
  setSteps(progress, steps);
}

// ── Token ───────────────────────────────────────────────────────────────────
function openTokenDialog() {
  const dlg = $('token-dialog');
  const owner = config.codeRepo.split('/')[0];
  const repoName = config.codeRepo.split('/')[1];
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…', 'aria-label': 'GitHub token' });
  const remember = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Connect' });
  const form = h('form', { method: 'dialog' },
    h('h3', { id: 'token-title', text: 'Connect GitHub' }),
    h('p', {}, 'Changes run as a GitHub Actions job in ', h('span', { class: 'mono', text: config.codeRepo }), '. Your token only needs to be allowed to start that job.'),
    h('ol', {},
      h('li', {}, ext('https://github.com/settings/personal-access-tokens/new', 'Create a fine-grained token'), `: resource owner ${owner}, only the repository ${repoName}, permission Actions: Read and write.`),
      h('li', { text: 'Paste it below.' })),
    h('p', { class: 'muted', text: 'A classic token with the repo scope works too. The token stays in this browser and is only sent to api.github.com.' }),
    h('label', {}, 'Token', input),
    h('label', { class: 'check' }, remember, 'Remember on this browser'),
    err,
    h('div', { class: 'buttons' }, h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() }), submit));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const token = input.value.trim();
    if (!token) { err.textContent = 'Paste a token first.'; return; }
    submit.disabled = true;
    err.textContent = '';
    const prev = state.token;
    state.token = token;
    try {
      const user = await api('GET', '/user');
      if (!user) throw new Error('GitHub did not accept this token.');
      // Kiểm quyền vào REPO, không kiểm workflow: tra workflow theo tên file trả 404 cả
      // khi token đúng mà workflow (nằm ngoài main) tạm mất đăng ký — loadRuns báo riêng.
      const repo = await api('GET', `/repos/${config.codeRepo}`);
      if (!repo) throw new Error(`This token cannot see ${config.codeRepo}. Give it access to that repository with Actions: Read and write. If your organization requires approval for fine-grained tokens, an owner has to approve it first.`);
      if (repo.permissions && !repo.permissions.push && !repo.permissions.admin && !repo.permissions.maintain) {
        throw new Error(`Your GitHub account needs write access to ${config.codeRepo} to start jobs there.`);
      }
      state.user = user;
      store.set('webota.token', token, remember.checked);
      dlg.close();
      toast(`Connected as @${user.login}.`);
      load();
    } catch (e) {
      state.token = prev;
      err.textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  });
  dlg.replaceChildren(form);
  dlg.showModal();
  input.focus();
}

function disconnect(manual) {
  store.del('webota.token');
  state.token = null;
  state.user = null;
  state.runs = [];
  if (manual) toast('Disconnected. The token was removed from this browser.');
  render();
}

// ── Khởi động ───────────────────────────────────────────────────────────────
$('app-name').textContent = config.appName;
document.title = `${config.appName} · Web OTA`;
$('refresh').addEventListener('click', () => load());
render();
if (state.token) {
  api('GET', '/user').then((u) => { state.user = u; renderAccount(); }).catch((e) => { if (e.status === 401) disconnect(false); });
}
load();
// Tự làm mới khi có token (5000 request/giờ); không token thì bấm Refresh.
setInterval(() => {
  if (state.token && !running && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) load();
}, 30_000);
