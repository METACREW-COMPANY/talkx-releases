// ota_core.mjs — logic Web OTA DÙNG CHUNG giữa CI và app mobile.
//
//   • CI     : web_ota.mjs import file này (resolver cho `ota status`, ký bản web).
//   • App    : 10_code_fixes/63_web_ota.sh chép NGUYÊN VĂN file này vào
//              project/src/lib/web-ota-core.js — updater trong app chọn bản web bằng
//              đúng resolver mà web_ota.check.mjs đã kiểm.
//
// ⚠️ Chạy được ở CẢ Node lẫn WebView: không import gì, không dùng API của Node.
//
// ── Chữ ký từng bản web ─────────────────────────────────────────────────────
// Repo release là public; ai ghi được vào đó là đẩy được JS chạy trong app. CI
// ký (ECDSA P-256, khoá riêng chỉ nằm trong secret WEB_OTA_SIGNING_KEY) phần BẤT
// BIẾN của mỗi bản web lúc phát hành: url + sha256 của bundle, các điều kiện
// tương thích, và env. App có public key (WEB_OTA_PUBLIC_KEY) nên chỉ chạy bundle
// do CI build. Ký từng bản chứ không ký cả channel.json: status / rollout /
// revoke / đăng ký native vẫn sửa được mà không cần khoá — kẻ sửa được
// channel.json cũng chỉ chọn được giữa các bản CI đã ký cho đúng env đó.

// Phần được ký của một bản web. Thêm field vào đây = bản cũ (ký thiếu field) không
// còn verify được trên app mới → chỉ THÊM khi đổi luôn cách ký (vd đổi tên field
// `signature`).
export const SIGNED_FIELDS = [
  'buildId', 'webVersion', 'commit', 'createdAt', 'url', 'sha256', 'size',
  'bridgeApiVersion', 'capacitor', 'platforms', 'requiredCapabilities',
];

// JSON với key sắp xếp ở mọi cấp — CI và app ra đúng cùng một chuỗi byte bất kể
// thứ tự key trong channel.json.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Chuỗi được ký cho bản web `build` của env `env`. Env đi vào chữ ký: bản ký cho
// stg không verify được trên app prod (và ngược lại) dù bị chép sang channel kia.
export function signedPayload(build, env) {
  const picked = { env: String(env) };
  for (const k of SIGNED_FIELDS) picked[k] = build[k] === undefined ? null : build[k];
  return canonicalJson(picked);
}

// So build number / version như tuple số — "1.0.10" > "1.0.9", "1000" > "431".
export function compareNativeIds(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Resolver — chọn bản web cho MỘT máy. Duyệt từ bản mới nhất, trả bản đầu tiên qua
// đủ điều kiện. `bucket` = 0..99, ổn định theo máy. `exclude` = các bản máy này
// không được chạy (đã thử và hỏng, sai chữ ký…). `current` = buildId máy đang chạy
// ('builtin' / null nếu không chạy bản OTA nào).
//
// status: approved = phát · paused = ngừng phát cho máy MỚI, máy đang chạy bản đó
// giữ nguyên (không bị kéo lùi) · pending = chưa phát · revoked = không bao giờ phát,
// máy đang chạy cũng lùi về bản cũ hơn. Bundle cũ (trước khi có `paused`) coi paused
// như revoked — an toàn, chỉ lùi thừa.
//
// Kết quả:
//   { build, reason: 'ok' }                    → chạy bản này
//   { build: null, reason: 'builtin-is-newest' } → bundle gốc của app là bản đúng
//   { build: null, reason: 'no-match' }          → không bản OTA nào hợp → bundle gốc
//   { build: null, reason: 'native-not-registered' } → binary này không có trong
//       channel.json (bản build tay, đăng ký lỗi…) → không biết gì, giữ nguyên.
export function resolveBuild(channel, { platform, nativeBuild, bucket = 0, exclude = [], current = null }) {
  const native = channel?.natives?.[platform]?.[String(nativeBuild)];
  if (!native) return { build: null, reason: 'native-not-registered' };
  for (const b of channel.builds || []) {
    // Bản cùng commit với native (hoặc cũ hơn native) = bundle đã nằm sẵn trong app.
    if (native.commit && b.commit === native.commit) return { build: null, reason: 'builtin-is-newest' };
    if (native.builtAt && String(b.createdAt) <= String(native.builtAt)) return { build: null, reason: 'builtin-is-newest' };
    if (b.status !== 'approved' && !(b.status === 'paused' && b.buildId === current)) continue; // đang phát (paused: chỉ máy đang chạy nó)
    if (!(b.platforms || []).includes(platform)) continue;                          // nền tảng
    if (exclude.includes(b.buildId)) continue;                                      // máy này không chạy bản này
    if (b.minNativeBuild != null && compareNativeIds(nativeBuild, b.minNativeBuild) < 0) continue; // khoảng native (chặn tay)
    if (b.maxNativeBuild != null && compareNativeIds(nativeBuild, b.maxNativeBuild) > 0) continue;
    if ((b.bridgeApiVersion ?? 0) > (native.bridgeApiVersion ?? 0)) continue;       // bridge API
    const have = new Set(native.capabilities || []);
    if (!(b.requiredCapabilities?.[platform] || []).every((c) => have.has(c))) continue; // capabilities
    if ((b.rollout ?? 100) < 100 && bucket >= b.rollout) continue;                  // rollout theo nhóm
    return { build: b, reason: 'ok' };
  }
  return { build: null, reason: 'no-match' };
}

// Bản web máy này PHẢI chạy: buildId, 'builtin' (bundle gốc của app), hoặc null =
// không biết (binary chưa đăng ký) → giữ nguyên bản đang chạy.
export function targetOf(result) {
  if (result.build) return result.build.buildId;
  return result.reason === 'native-not-registered' ? null : 'builtin';
}

// base64 / base64url → Uint8Array (atob có ở cả WebView lẫn Node ≥ 16).
export function base64ToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Kiểm chữ ký một bản web bằng WebCrypto (crypto.subtle — WebView và Node đều có).
// publicKey = SPKI DER base64 (WEB_OTA_PUBLIC_KEY). Chữ ký = r||s 64 byte (IEEE
// P1363) base64url — dạng WebCrypto dùng; Node ký với dsaEncoding 'ieee-p1363'.
export async function verifyBuild(build, env, publicKey, subtle = globalThis.crypto?.subtle) {
  if (!build?.signature) return false;
  if (!subtle) throw new Error('crypto.subtle is not available');
  const key = await subtle.importKey('spki', base64ToBytes(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const data = new TextEncoder().encode(signedPayload(build, env));
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, base64ToBytes(build.signature), data);
}
