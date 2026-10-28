// ota_view.mjs — thao tác quản lý channel.json + "máy nào nhận bản nào", DÙNG CHUNG
// giữa CLI (`mobile-ci ota …`, web_ota.mjs) và Web OTA console (trang GitHub Pages,
// mobile-ci/web-ota-console/). Console dùng đúng các hàm này để XEM TRƯỚC một thao
// tác trước khi gửi workflow web-ota.yml chạy thật → xem trước khớp với kết quả.
//
// ⚠️ Chạy được ở CẢ Node lẫn trình duyệt: chỉ import ota_core.mjs, không dùng API
// của Node. KHÔNG chép vào app (app chỉ cần ota_core.mjs).
import { compareNativeIds, resolveBuild, targetOf } from './ota_core.js';

export const STATUSES = ['approved', 'paused', 'pending', 'revoked'];

// Lỗi do người dùng (sai buildId, sai trạng thái…) — CLI trả exit 2, console hiện nguyên văn.
export class OtaActionError extends Error {
  constructor(message) { super(message); this.name = 'OtaActionError'; }
}

function findBuild(channel, buildId) {
  const b = (channel.builds || []).find((x) => x.buildId === buildId);
  if (!b) throw new OtaActionError(`build "${buildId}" is not in channel.json (see: mobile-ci ota status)`);
  return b;
}

export function setStatus(channel, buildId, status) {
  if (!STATUSES.includes(status)) throw new OtaActionError(`unknown status "${status}"`);
  findBuild(channel, buildId).status = status;
  return channel;
}

export function setRollout(channel, buildId, percent) {
  const n = Number(percent);
  if (String(percent).trim() === '' || !Number.isInteger(n) || n < 0 || n > 100) throw new OtaActionError(`rollout must be an integer 0–100, got "${percent}"`);
  findBuild(channel, buildId).rollout = n;
  return channel;
}

// Các bản `rollback-to <buildId>` sẽ thu hồi: mọi bản MỚI HƠN bản đích đang phát
// (approved / paused). Bản pending mới hơn giữ nguyên — có thể chính là bản sửa lỗi
// đang chờ promote.
export function rollbackRevokes(channel, buildId) {
  const builds = channel.builds || [];
  const i = builds.findIndex((x) => x.buildId === buildId);
  if (i < 0) throw new OtaActionError(`build "${buildId}" is not in channel.json (see: mobile-ci ota status)`);
  return builds.slice(0, i).filter((b) => b.status === 'approved' || b.status === 'paused').map((b) => b.buildId);
}

// Thao tác quản lý — idempotent (updateChannel có thể chạy lại mutate khi ghi đụng nhau).
//   promote      pending / paused / revoked → approved (khôi phục bản đã thu hồi cũng bằng lệnh này)
//   resume       paused → approved
//   pause        approved → paused: máy mới không nhận, máy đang chạy giữ nguyên
//   revoke       → revoked: không phát nữa, máy đang chạy lùi về bản cũ hơn
//   rollout      % thiết bị nhận bản này (0–100)
//   rollback-to  thu hồi mọi bản đang phát mới hơn bản đích, bản đích → approved
export const ACTIONS = ['promote', 'resume', 'pause', 'revoke', 'rollout', 'rollback-to'];

export function applyAction(channel, { action, buildId, percent }) {
  if (!buildId) throw new OtaActionError(`${action}: missing buildId`);
  const b = findBuild(channel, buildId);
  switch (action) {
    case 'promote':
      return setStatus(channel, buildId, 'approved');
    case 'resume':
      if (b.status !== 'paused' && b.status !== 'approved') throw new OtaActionError(`resume: ${buildId} is ${b.status}, not paused (use promote for pending / revoked builds)`);
      return setStatus(channel, buildId, 'approved');
    case 'pause':
      if (b.status !== 'approved' && b.status !== 'paused') throw new OtaActionError(`pause: ${buildId} is ${b.status} — only a served (approved) build can be paused`);
      return setStatus(channel, buildId, 'paused');
    case 'revoke':
      return setStatus(channel, buildId, 'revoked');
    case 'rollout':
      return setRollout(channel, buildId, percent);
    case 'rollback-to': {
      if (b.status === 'revoked') throw new OtaActionError(`rollback-to: ${buildId} is revoked — restore it first (promote), then roll back to it`);
      for (const id of rollbackRevokes(channel, buildId)) setStatus(channel, id, 'revoked');
      return setStatus(channel, buildId, 'approved');
    }
    default:
      throw new OtaActionError(`unknown action "${action}" (one of: ${ACTIONS.join(', ')})`);
  }
}

// Thao tác đã có hiệu lực trên `channel` chưa — verify của updateChannel.
export function actionDone(channel, { action, buildId, percent }) {
  const b = (channel.builds || []).find((x) => x.buildId === buildId);
  if (!b) return false;
  switch (action) {
    case 'promote': case 'resume': return b.status === 'approved';
    case 'pause': return b.status === 'paused';
    case 'revoke': return b.status === 'revoked';
    case 'rollout': return b.rollout === Number(percent);
    case 'rollback-to': return b.status === 'approved' && rollbackRevokes(channel, buildId).length === 0;
    default: return false;
  }
}

// Bản web một native (platform + build number) nhận, theo từng nhóm rollout: máy có
// bucket from..to (0–99) chạy `target` (buildId | 'builtin' | null = native chưa
// đăng ký). Máy MỚI / đang chạy bản khác — bản paused chỉ giữ máy đang chạy nó.
export function servingPlan(channel, platform, nativeBuild, { current = null, exclude = [] } = {}) {
  const segs = [];
  for (let bucket = 0; bucket < 100; bucket++) {
    const res = resolveBuild(channel, { platform, nativeBuild, bucket, exclude, current });
    const target = targetOf(res);
    const last = segs[segs.length - 1];
    if (last && last.target === target) last.to = bucket;
    else segs.push({ from: bucket, to: bucket, target, reason: res.reason });
  }
  return segs.map((s) => ({ ...s, percent: s.to - s.from + 1 }));
}

// Các native mới nhất của từng nền tảng (mặc định 3) + bản web mỗi native nhận.
export function servingOverview(channel, { perPlatform = 3 } = {}) {
  const rows = [];
  for (const platform of ['android', 'ios']) {
    const natives = channel?.natives?.[platform] || {};
    const ids = Object.keys(natives).sort(compareNativeIds).reverse().slice(0, perPlatform);
    for (const id of ids) {
      rows.push({ platform, nativeBuild: id, appVersion: natives[id].appVersion, builtAt: natives[id].builtAt, commit: natives[id].commit, plan: servingPlan(channel, platform, id) });
    }
  }
  return rows;
}

// "web-x 100%" / "web-x 10% · web-y 90%" — một dòng cho log / job summary / console.
export function planText(plan) {
  const name = (t) => (t === null ? 'unchanged (native not registered)' : t === 'builtin' ? 'built-in bundle' : t);
  if (plan.length === 1) return name(plan[0].target);
  return plan.map((s) => `${name(s.target)} ${s.percent}%`).join(' · ');
}

// So kế hoạch phát trước / sau một thao tác: chỉ những native đổi bản nhận.
export function planDiff(before, after) {
  const key = (r) => `${r.platform}:${r.nativeBuild}`;
  const prev = new Map(before.map((r) => [key(r), planText(r.plan)]));
  return after
    .map((r) => ({ platform: r.platform, nativeBuild: r.nativeBuild, appVersion: r.appVersion, before: prev.get(key(r)) ?? '—', after: planText(r.plan) }))
    .filter((d) => d.before !== d.after);
}

// ── Nhóm theo phiên bản app (console: mỗi bản mobile một khối) ───────────────

const OLDER_THAN_BUILTIN = 'older than the web built into the app';

// Bản `buildId` có chạy được trên native này không — hỏi CHÍNH resolver (channel chỉ
// còn bản đó, coi như approved 100%) nên không lệch với app.
export function fitsNative(channel, platform, nativeBuild, buildId) {
  const b = (channel.builds || []).find((x) => x.buildId === buildId);
  if (!b) return false;
  const only = { ...channel, builds: [{ ...b, status: 'approved', rollout: 100 }] };
  return resolveBuild(only, { platform, nativeBuild }).build?.buildId === buildId;
}

// Vì sao không chạy được — chỉ để HIỂN THỊ (quyết định chạy/không là fitsNative).
export function whyNotFit(channel, platform, nativeBuild, b) {
  const n = channel?.natives?.[platform]?.[String(nativeBuild)];
  if (!n) return 'app build not registered';
  if ((n.commit && b.commit === n.commit) || (n.builtAt && String(b.createdAt) <= String(n.builtAt))) return OLDER_THAN_BUILTIN;
  if (!(b.platforms || []).includes(platform)) return `not built for ${platform}`;
  if (b.minNativeBuild != null && compareNativeIds(nativeBuild, b.minNativeBuild) < 0) return `needs app build ${b.minNativeBuild} or newer`;
  if (b.maxNativeBuild != null && compareNativeIds(nativeBuild, b.maxNativeBuild) > 0) return `only up to app build ${b.maxNativeBuild}`;
  if ((b.bridgeApiVersion ?? 0) > (n.bridgeApiVersion ?? 0)) return `needs bridge API ${b.bridgeApiVersion} (app has ${n.bridgeApiVersion ?? 0})`;
  const have = new Set(n.capabilities || []);
  const missing = (b.requiredCapabilities?.[platform] || []).filter((c) => !have.has(c));
  if (missing.length) return `needs ${missing.join(', ')}`;
  return null;
}

// Mỗi phiên bản app (appVersion) một nhóm, mới nhất trước:
//   natives: các bản native (platform + build number) của phiên bản đó + kế hoạch phát
//   builds : các bản web MỚI HƠN web gốc trong app (bản cũ hơn không bao giờ được chọn),
//            mỗi bản kèm từng native: chạy được không / vì sao / % thiết bị đang nhận.
// status / rollout của bản web là CHUNG cho mọi phiên bản app.
export function versionGroups(channel) {
  const byVersion = new Map();
  for (const platform of ['android', 'ios']) {
    for (const [id, n] of Object.entries(channel?.natives?.[platform] || {})) {
      const v = String(n.appVersion ?? '?');
      if (!byVersion.has(v)) byVersion.set(v, { appVersion: v, natives: [], builds: [] });
      byVersion.get(v).natives.push({ platform, nativeBuild: id, builtAt: n.builtAt, commit: n.commit, plan: servingPlan(channel, platform, id) });
    }
  }
  const groups = [...byVersion.values()].sort((a, b) => compareNativeIds(b.appVersion, a.appVersion));
  for (const g of groups) {
    g.natives.sort((a, b) => a.platform.localeCompare(b.platform) || compareNativeIds(b.nativeBuild, a.nativeBuild));
    for (const b of channel.builds || []) {
      const per = g.natives.map((n) => {
        const fits = fitsNative(channel, n.platform, n.nativeBuild, b.buildId);
        const serving = n.plan.filter((s) => s.target === b.buildId).reduce((sum, s) => sum + s.percent, 0);
        return { platform: n.platform, nativeBuild: n.nativeBuild, fits, why: fits ? null : (whyNotFit(channel, n.platform, n.nativeBuild, b) || 'not compatible'), serving };
      });
      if (per.every((x) => x.why === OLDER_THAN_BUILTIN)) continue;
      g.builds.push({ build: b, per });
    }
  }
  return groups;
}

// Bản web không nằm trong nhóm nào (cũ hơn web gốc của MỌI phiên bản đã đăng ký).
export function ungroupedBuilds(channel, groups = versionGroups(channel)) {
  const seen = new Set(groups.flatMap((g) => g.builds.map((x) => x.build.buildId)));
  return (channel?.builds || []).filter((b) => !seen.has(b.buildId));
}

// ── history.json → channel.json ─────────────────────────────────────────────
// history.json = nguồn gốc: MỌI bản web + MỌI native từng có + nhật ký, không bao giờ
// cắt (CI / CLI / console đọc). channel.json = thứ app tải mỗi lần kiểm — CI SINH LẠI
// từ history ở mỗi lần ghi, chỉ giữ đúng những gì resolver cần → nhỏ, gần như cố định.
// checkDerived chứng minh bằng chính resolver: app đọc channel nhỏ chọn ĐÚNG như đọc
// lịch sử đầy đủ; lệch thì CI không ghi.

// Số bản approved 100% giữ thêm SAU "sàn" (bản approved 100% đầu tiên chạy được) của
// mỗi native: máy đã đánh dấu hỏng / sai chữ ký bản trên thì chọn tiếp xuống dưới.
export const FALLBACK_DEPTH = 3;

const SERVABLE = new Set(['approved', 'paused']);
const isCutoff = (n, b) => Boolean((n.commit && b.commit === n.commit) || (n.builtAt && String(b.createdAt) <= String(n.builtAt)));
// Field native mà resolver (app) đọc — phần còn lại (nativeInputs*, capacitor…) chỉ CI dùng.
const APP_NATIVE_FIELDS = ['appVersion', 'bridgeApiVersion', 'capabilities', 'commit', 'builtAt'];

export function deriveChannel(history, { depth = FALLBACK_DEPTH } = {}) {
  const keep = new Set();
  const natives = {};
  for (const platform of ['android', 'ios']) {
    natives[platform] = {};
    for (const [id, n] of Object.entries(history?.natives?.[platform] || {})) {
      natives[platform][id] = Object.fromEntries(APP_NATIVE_FIELDS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));
      let floor = false;
      let after = 0;
      for (const b of history.builds || []) {
        // Bản "chặn" (cùng commit / cũ hơn web gốc): resolver dừng ở đó BẤT KỂ status →
        // luôn giữ, nếu không app có thể trượt xuống bản cũ hơn web gốc của chính nó.
        if (isCutoff(n, b)) { keep.add(b.buildId); break; }
        if (!SERVABLE.has(b.status) || whyNotFit(history, platform, id, b) !== null) continue;
        keep.add(b.buildId);
        // Chỉ bản approved 100% mới chọn được cho MỌI máy (paused chỉ cho máy đang chạy
        // nó, rollout một phần chỉ cho một nhóm) → chỉ chúng được đếm vào `depth`; mọi
        // bản xen giữa vẫn giữ để thứ tự resolver đi qua y như lịch sử đủ.
        const everyone = b.status === 'approved' && (b.rollout ?? 100) >= 100;
        if (floor) { if (everyone && ++after >= depth) break; }
        else if (everyone) floor = true;
      }
    }
  }
  return {
    schema: history.schema ?? 1, env: history.env, repo: history.repo, rev: history.rev ?? 0, updatedAt: history.updatedAt ?? null,
    natives,
    builds: (history.builds || []).filter((b) => keep.has(b.buildId)),
  };
}

// Mọi chỗ app có thể chọn khác nhau giữa lịch sử đầy đủ và channel nhỏ. Với mỗi native ×
// mỗi nhóm rollout (chỉ thử ở các ngưỡng rollout — giữa hai ngưỡng kết quả như nhau) ×
// bản máy đang chạy (không gì / từng bản paused) × chuỗi "bản trên hỏng" dài tối đa
// `depth`. Trả [] = khớp hoàn toàn.
export function checkDerived(history, channel, { depth = FALLBACK_DEPTH, limit = 5 } = {}) {
  const bad = [];
  const cuts = new Set([0, 99]);
  for (const b of history.builds || []) {
    const r = b.rollout ?? 100;
    if (r > 0 && r < 100) { cuts.add(r - 1); cuts.add(r); }
  }
  const buckets = [...cuts].filter((x) => x >= 0 && x <= 99).sort((x, y) => x - y);
  const paused = (history.builds || []).filter((b) => b.status === 'paused').map((b) => b.buildId);
  for (const platform of ['android', 'ios']) {
    for (const nativeBuild of Object.keys(history?.natives?.[platform] || {})) {
      for (const bucket of buckets) {
        for (const current of [null, ...paused]) {
          const exclude = [];
          for (let step = 0; step <= depth; step++) {
            const full = targetOf(resolveBuild(history, { platform, nativeBuild, bucket, current, exclude }));
            const small = targetOf(resolveBuild(channel, { platform, nativeBuild, bucket, current, exclude }));
            if (full !== small) {
              bad.push({ platform, nativeBuild, bucket, current, exclude: [...exclude], full, small });
              if (bad.length >= limit) return bad;
            }
            if (!full || full === 'builtin') break;
            exclude.push(full);
          }
        }
      }
    }
  }
  return bad;
}

// Sự kiện cho nhật ký (history.events) từ khác biệt trước / sau một lần ghi.
export function diffEvents(before, after) {
  const out = [];
  const old = new Map((before?.builds || []).map((b) => [b.buildId, b]));
  for (const b of after?.builds || []) {
    const o = old.get(b.buildId);
    if (!o) { out.push({ type: 'publish', buildId: b.buildId, to: b.status }); continue; }
    if (o.status !== b.status) out.push({ type: 'status', buildId: b.buildId, from: o.status, to: b.status });
    if ((o.rollout ?? 100) !== (b.rollout ?? 100)) out.push({ type: 'rollout', buildId: b.buildId, from: o.rollout ?? 100, to: b.rollout ?? 100 });
  }
  for (const platform of ['android', 'ios']) {
    for (const [id, n] of Object.entries(after?.natives?.[platform] || {})) {
      if (!before?.natives?.[platform]?.[id]) out.push({ type: 'register', platform, nativeBuild: id, appVersion: n.appVersion });
    }
  }
  return out;
}
