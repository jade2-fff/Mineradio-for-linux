// ====================================================================
//  酷狗音乐 (Kugou) 数据源 —— 独立模块
//   - 公开 mobile/pc web 接口，带 cookie 即可走会员/收藏歌单
//   - 搜索 / 歌曲URL / 歌词 / 评论 / 歌手 / 歌单 / 登录态
//   - 自管 cookie 文件、dfid/mid 设备指纹状态
//   - 通过 createKugouProvider(deps) 注入共享工具，避免与 server.js 耦合
// ====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const KUGOU_RSA_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n' +
  '-----END PUBLIC KEY-----';

// ---------- 共享工具（轻量本地实现，避免依赖注入过多） ----------
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  const attr = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
  String(input || '').split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      const key = raw.slice(0, idx).trim();
      if (attr.has(key.toLowerCase())) return;
      picked.set(key, raw.slice(idx + 1).trim());
    });
  });
  return Array.from(picked.entries())
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
function md5Hex(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex');
}
function randomMid() {
  const id = crypto.randomBytes(16).toString('hex');
  return md5Hex(id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20));
}
function signWeb(params) {
  const salt = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const joined = Object.keys(params || {})
    .filter(k => k !== 'signature' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => `${k}=${params[k]}`)
    .sort()
    .join('');
  return md5Hex(salt + joined + salt);
}
function qrPayloadUrl(qrcode) {
  return 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + encodeURIComponent(qrcode);
}
function qrPngUrl(data) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(data);
}
function requestTextWithHeaders(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          err.headers = response.headers || {};
          reject(err);
          return;
        }
        resolve({ text, headers: response.headers || {}, statusCode: response.statusCode });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieHeaderFromSetCookie(setCookie) {
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .filter(Boolean)
    .map(item => String(item).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}
function safeDecodeCookieValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch (e) {}
  try {
    return raw.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  } catch (e) { return raw; }
}
function parsePackedKugouCookie(cookieObj) {
  const packed = String((cookieObj && cookieObj.KuGoo) || '');
  const out = {};
  packed.split('&').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  });
  return out;
}
function signAndroid(params, body) {
  const salt = 'OIlwieks28dk2k092lksi2UIkp';
  const joined = Object.keys(params || {})
    .filter(k => k !== 'signature' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
    .join('');
  return md5Hex(salt + joined + (body || '') + salt);
}
function pemPublicKeyToJwk(pem) {
  const der = Buffer.from(String(pem).replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, ''), 'base64');
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return key.export({ format: 'jwk' });
}
function base64UrlToBuffer(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64');
}
function base64UrlToBigInt(text) {
  const buf = base64UrlToBuffer(text);
  return BigInt('0x' + (buf.toString('hex') || '0'));
}
function bigIntToFixedHex(value, bytes) {
  return value.toString(16).padStart(bytes * 2, '0');
}
function rsaRawEncryptJson(data) {
  const jwk = pemPublicKeyToJwk(KUGOU_RSA_PUBLIC_KEY);
  const n = base64UrlToBigInt(jwk.n);
  const e = base64UrlToBigInt(jwk.e);
  const keyBytes = base64UrlToBuffer(jwk.n).length;
  const input = Buffer.from(JSON.stringify(data || {}), 'utf8');
  if (input.length > keyBytes) throw new Error('KUGOU_RSA_INPUT_TOO_LONG');
  const padded = Buffer.alloc(keyBytes);
  input.copy(padded, 0);
  const encrypted = modPow(BigInt('0x' + padded.toString('hex')), e, n);
  return bigIntToFixedHex(encrypted, keyBytes);
}
function modPow(base, exponent, modulus) {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base = base % modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) result = (result * base) % modulus;
    exponent = exponent / 2n;
    base = (base * base) % modulus;
  }
  return result;
}
function aesCbcEncryptHex(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([cipher.update(Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8')), cipher.final()]).toString('hex');
}
function aesCbcDecryptHex(text, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const out = Buffer.concat([decipher.update(Buffer.from(String(text || ''), 'hex')), decipher.final()]).toString('utf8');
  try { return JSON.parse(out); } catch (e) { return out; }
}
function randomString(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function aesCbcEncryptAuto(data) {
  const tempKey = randomString(16).toLowerCase();
  const key = md5Hex(tempKey).substring(0, 32);
  const iv = key.substring(key.length - 16);
  return { key: tempKey, str: aesCbcEncryptHex(data, key, iv) };
}
function playlistAesEncrypt(data) {
  const tempKey = randomString(6).toLowerCase();
  const hash = md5Hex(tempKey);
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(hash.substring(0, 16), 'utf8'), Buffer.from(hash.substring(16, 32), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8')), cipher.final()]);
  return { key: tempKey, str: encrypted.toString('base64') };
}
function rsaPkcs1EncryptJson(data) {
  return crypto.publicEncrypt({ key: KUGOU_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(JSON.stringify(data || {}), 'utf8')).toString('hex');
}

// ====================================================================
//  createKugouProvider(deps)
//    deps = {
//      requestText,                  // (url, opts, body) => Promise<string>
//      UA,                            // User-Agent 字符串
//      normalizeQualityPreference,    // (value) => 'standard'|'exhigh'|...
//      playbackRestriction,           // (provider, category, msg, action, extra) => obj
//      decodeQQLyricText,             // 兼容 base64 的歌词解码（酷狗与 QQ 共用语义）
//      decodeHtmlEntities,            // HTML 实体解码
//      cookieFile,                    // cookie 持久化路径
//    }
// ====================================================================
function createKugouProvider(deps) {
  const requestText = deps.requestText;
  const UA = deps.UA;
  const normalizeQualityPreference = deps.normalizeQualityPreference;
  const playbackRestriction = deps.playbackRestriction;
  const decodeQQLyricText = deps.decodeQQLyricText;
  const decodeHtmlEntities = deps.decodeHtmlEntities;
  const COOKIE_FILE = deps.cookieFile || path.join(__dirname, '.kugou-cookie');

  const HEADERS = {
    'User-Agent': UA,
    Referer: 'https://www.kugou.com/',
    Origin: 'https://www.kugou.com',
    Accept: 'application/json, text/plain, */*',
  };
  const qrLoginJobs = new Map();

  // 酷狗播放地址需要 dfid（设备指纹）+ mid（用户指纹）+ userid
  let kugouCookie = '';
  let kugouDfid = '';
  let kugouMid = '';
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      kugouCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      const obj = parseCookieString(kugouCookie);
      kugouDfid = obj.kugou_dfid || obj.dfid || '';
      kugouMid = obj.mid || obj.kugou_mid || '';
    }
  } catch (e) {}

  function persistCookie(text) {
    kugouCookie = text || '';
    try { fs.writeFileSync(COOKIE_FILE, kugouCookie); } catch (e) {}
  }

  function userId() {
    if (!kugouCookie) return '';
    const obj = parseCookieString(kugouCookie);
    return obj.userid || obj.kugou_userid || obj.KUGOO_ID || '';
  }

  function syncFingerprint(cookieText) {
    const obj = parseCookieString(cookieText);
    kugouDfid = obj.kugou_dfid || obj.dfid || kugouDfid;
    kugouMid = obj.mid || obj.kugou_mid || kugouMid;
  }

  function requestParam(extra) {
    const base = {
      srcappid: '2919',
      clientver: '1.0.0',
      clienttime: Math.floor(Date.now() / 1000),
      mid: kugouMid || '0'.repeat(24),
      dfid: kugouDfid || '0'.repeat(24),
      userid: userId() || '0',
    };
    return Object.assign({}, base, extra || {});
  }

  function signedKey(params) {
    // 酷狗 web 接口签名：参数按 key 排序拼成 a=1&b=2，再拼固定 salt
    const salt = 'OIlwieks4dk2aj09fj09dsajfij93inmfvwINimFOSDIjp4i49esvqwc23rf4incoiw';
    const keys = Object.keys(params).filter(k => params[k] != null && params[k] !== '').sort();
    const query = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    return crypto.createHash('md5').update(query + salt).digest('hex').toUpperCase();
  }

  function loginToken() {
    if (!kugouCookie) return '';
    const obj = parseCookieString(kugouCookie);
    return obj.token || obj.t || '';
  }
  function vipToken() {
    if (!kugouCookie) return '';
    const obj = parseCookieString(kugouCookie);
    return obj.vip_token || obj.vipToken || obj.vip_t || '';
  }

  async function kugouGatewayRequest(pathname, query, bodyObj, router) {
    const obj = parseCookieString(kugouCookie);
    const body = JSON.stringify(bodyObj || {});
    const params = Object.assign({
      dfid: kugouDfid || obj.dfid || '-',
      mid: kugouMid || obj.mid || obj.KUGOU_API_MID || '-',
      uuid: '-',
      appid: '1005',
      clientver: '20489',
      clienttime: Math.floor(Date.now() / 1000),
    }, query || {});
    const token = loginToken();
    const uid = userId();
    if (token && params.token == null) params.token = token;
    if (uid && params.userid == null) params.userid = uid;
    params.signature = signAndroid(params, body);
    const u = new URL('https://gateway.kugou.com' + pathname);
    Object.keys(params).forEach(k => {
      if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
    });
    const headers = {
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      dfid: params.dfid,
      mid: params.mid,
      clienttime: params.clienttime,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    };
    if (router) headers['x-router'] = router;
    if (kugouCookie) headers.Cookie = kugouCookie;
    const text = await requestText(u.toString(), { headers, method: 'POST' }, body);
    const json = JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
    if (json && json.status === 0 && (json.error_code || json.error)) {
      const err = new Error('KUGOU_GATEWAY_' + (json.error_code || json.error));
      err.body = json;
      throw err;
    }
    return json;
  }

  async function registerAndroidDevice() {
    const obj = parseCookieString(kugouCookie);
    const token = loginToken();
    const userid = userId() || '0';
    const guid = obj.KUGOU_API_GUID || obj.mid || kugouMid || randomMid();
    const dataMap = {
      availableRamSize: 4983533568,
      availableRomSize: 48114719,
      availableSDSize: 48114717,
      basebandVer: '',
      batteryLevel: 100,
      batteryStatus: 3,
      brand: 'Redmi',
      buildSerial: 'unknown',
      device: 'marble',
      imei: guid,
      imsi: '',
      manufacturer: 'Xiaomi',
      uuid: guid,
      accelerometer: false,
      accelerometerValue: '',
      gravity: false,
      gravityValue: '',
      gyroscope: false,
      gyroscopeValue: '',
      light: false,
      lightValue: '',
      magnetic: false,
      magneticValue: '',
      orientation: false,
      orientationValue: '',
      pressure: false,
      pressureValue: '',
      step_counter: false,
      step_counterValue: '',
      temperature: false,
      temperatureValue: '',
    };
    const box = playlistAesEncrypt(dataMap);
    const p = rsaPkcs1EncryptJson({ aes: box.key, uid: userid, token });
    const body = box.str;
    const params = {
      dfid: obj.dfid || kugouDfid || '-',
      mid: kugouMid || obj.mid || guid,
      uuid: '-',
      appid: '1005',
      clientver: '20489',
      clienttime: Math.floor(Date.now() / 1000),
      part: 1,
      platid: 1,
      p,
    };
    params.signature = signAndroid(params, body);
    const u = new URL('https://userservice.kugou.com/risk/v2/r_register_dev');
    Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])));
    const resp = await requestTextWithHeaders(u.toString(), {
      method: 'POST',
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        dfid: params.dfid,
        mid: params.mid,
        clienttime: params.clienttime,
        Cookie: kugouCookie,
      },
    }, body);
    const headerCookie = cookieHeaderFromSetCookie(resp.headers && resp.headers['set-cookie']);
    const dfidMatch = String(resp.text || '').match(/dfid["']?\s*[:=]\s*["']([^"']+)/i);
    const additions = [];
    if (dfidMatch && dfidMatch[1]) additions.push('dfid=' + dfidMatch[1]);
    const merged = normalizeCookieHeader([kugouCookie, headerCookie, additions.join('; ')].filter(Boolean).join('; '));
    if (merged && merged !== kugouCookie) {
      persistCookie(merged);
      syncFingerprint(merged);
      return true;
    }
    return !!additions.length;
  }

  async function refreshAndroidLoginToken() {
    const obj = parseCookieString(kugouCookie);
    const token = loginToken();
    const userid = userId();
    if (!token || !userid) return false;
    const nowMs = Date.now();
    const p3 = aesCbcEncryptHex({ clienttime: Math.floor(nowMs / 1000), token }, '90b8382a1bb4ccdcf063102053fd75b8', 'f063102053fd75b8');
    const paramsBox = aesCbcEncryptAuto({});
    const pk = rsaRawEncryptJson({ clienttime_ms: nowMs, key: paramsBox.key });
    const data = {
      dfid: obj.dfid || kugouDfid || '-',
      p3,
      plat: 1,
      t1: 0,
      t2: 0,
      t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
      pk,
      params: paramsBox.str,
      userid,
      clienttime_ms: nowMs,
    };
    const body = JSON.stringify(data);
    const params = {
      dfid: data.dfid,
      mid: kugouMid || obj.mid || '-',
      uuid: '-',
      appid: '1005',
      clientver: '20489',
      clienttime: Math.floor(nowMs / 1000),
      token,
      userid,
    };
    params.signature = signAndroid(params, body);
    const u = new URL('http://login.user.kugou.com/v5/login_by_token');
    Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])));
    const refreshHeaders = {
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      dfid: params.dfid,
      mid: params.mid,
      clienttime: params.clienttime,
      Cookie: kugouCookie,
    };
    const text = await requestText(u.toString(), { method: 'POST', headers: refreshHeaders }, body);
    const json = JSON.parse(text || '{}');
    if (!(json && json.status === 1 && json.data)) return false;
    const additions = [];
    if (json.data.secu_params) {
      try {
        const decoded = aesCbcDecryptHex(json.data.secu_params, md5Hex(paramsBox.key).substring(0, 32), md5Hex(paramsBox.key).substring(16, 32));
        if (decoded && typeof decoded === 'object') {
          Object.keys(decoded).forEach(k => additions.push(k + '=' + decoded[k]));
        } else if (decoded) {
          additions.push('token=' + decoded);
        }
      } catch (e) {
        console.warn('[KugouLoginToken] secu_params decrypt failed:', e.message);
      }
    }
    ['token', 'userid', 'vip_type', 'vip_token', 't1'].forEach(k => {
      if (json.data[k] != null && String(json.data[k]) !== '') additions.push(k + '=' + json.data[k]);
    });
    const headerCookie = '';
    const merged = normalizeCookieHeader([kugouCookie, headerCookie, additions.join('; ')].filter(Boolean).join('; '));
    if (merged && merged !== kugouCookie) {
      persistCookie(merged);
      syncFingerprint(merged);
    }
    return true;
  }

  async function kugouRequest(apiUrl, params, opts) {
    opts = opts || {};
    const fullParams = requestParam(params);
    if (opts.signed !== false) fullParams.signature = signedKey(fullParams);
    const u = new URL(apiUrl);
    Object.keys(fullParams).forEach(k => {
      if (fullParams[k] != null && fullParams[k] !== '') u.searchParams.set(k, String(fullParams[k]));
    });
    const headers = { ...HEADERS };
    if (opts.cookie !== false && kugouCookie) headers.Cookie = kugouCookie;
    const text = await requestText(u.toString(), { headers, method: opts.method || 'GET' }, opts.body);
    return JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
  }

  // ---------- 业务: 二维码登录 ----------
  function qrBaseParams(mid, appid) {
    const clienttime = Math.floor(Date.now() / 1000);
    return {
      appid: String(appid || '1005'),
      clientver: '20489',
      clienttime,
      dfid: '-',
      mid,
      uuid: mid,
      plat: '4',
      srcappid: '2919',
    };
  }

  async function createQrLogin() {
    const mid = randomMid();
    const params = Object.assign(qrBaseParams(mid, '1001'), {
      type: '1',
      qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&',
    });
    params.signature = signWeb(params);
    const u = new URL('https://login-user.kugou.com/v2/qrcode');
    Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])));
    const text = await requestText(u.toString(), { headers: HEADERS });
    const body = JSON.parse(text);
    const qrcode = body && body.data && (body.data.qrcode || body.data.key || body.data.qrcode_txt);
    if (!qrcode) throw new Error((body && (body.error_msg || body.message)) || 'KUGOU_QR_CREATE_FAILED');
    const id = crypto.randomBytes(12).toString('hex');
    const payloadUrl = qrPayloadUrl(qrcode);
    const job = { id, mid, qrcode, payloadUrl, createdAt: Date.now(), status: 1 };
    qrLoginJobs.set(id, job);
    return {
      provider: 'kugou',
      id,
      key: id,
      qrcode,
      url: payloadUrl,
      img: qrPngUrl(payloadUrl),
      expiresIn: 180,
    };
  }

  async function autoLoginFromQr(job, token, userid) {
    const clienttime = Math.floor(Date.now() / 1000);
    const u = new URL('https://login-user.kugou.com/v1/autologin');
    const params = {
      a_id: '1014',
      userid: String(userid),
      t: token,
      ct: clienttime,
      callback: 'qrcodeLoginCallback',
      domain: 'kugou.com',
      uuid: job.mid,
      mid: '$' + job.mid,
      plat: '4',
      dfid: '-',
      kguser_jv: '180925',
    };
    Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])));
    let cookieFromHeader = '';
    try {
      const resp = await requestTextWithHeaders(u.toString(), { headers: HEADERS });
      cookieFromHeader = cookieHeaderFromSetCookie(resp.headers['set-cookie']);
    } catch (e) {
      console.warn('[KugouQrLogin] autologin cookie fetch failed:', e.message);
    }
    const merged = normalizeCookieHeader(cookieFromHeader + '; userid=' + userid + '; token=' + token + '; mid=' + job.mid + '; dfid=-');
    if (!merged) throw new Error('KUGOU_AUTOLOGIN_COOKIE_MISSING');
    persistCookie(merged);
    syncFingerprint(merged);
    return merged;
  }

  async function checkQrLogin(id) {
    const job = qrLoginJobs.get(String(id || ''));
    if (!job) return { provider: 'kugou', code: 800, status: 0, message: '二维码已过期，请刷新' };
    if (Date.now() - job.createdAt > 180000) {
      qrLoginJobs.delete(job.id);
      return { provider: 'kugou', code: 800, status: 0, message: '二维码已过期，请刷新' };
    }
    const params = Object.assign(qrBaseParams(job.mid, '1005'), {
      qrcode: job.qrcode,
    });
    params.signature = signWeb(params);
    const u = new URL('https://login-user.kugou.com/v2/get_userinfo_qrcode');
    Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])));
    const text = await requestText(u.toString(), { headers: HEADERS });
    const body = JSON.parse(text);
    const data = (body && body.data) || {};
    const status = Number(data.status);
    if (status === 4) {
      const token = data.token || data.t || '';
      const userid = data.userid || data.user_id || '';
      if (!token || !userid) return { provider: 'kugou', code: 802, status, message: '已确认，正在获取登录凭证' };
      const cookie = await autoLoginFromQr(job, token, userid);
      qrLoginJobs.delete(job.id);
      const info = await getLoginInfo();
      return { provider: 'kugou', code: 803, status, message: '登录成功', hasCookie: !!cookie, ...info };
    }
    if (status === 0) {
      qrLoginJobs.delete(job.id);
      return { provider: 'kugou', code: 800, status, message: '二维码已过期，请刷新' };
    }
    if (status === 2) return { provider: 'kugou', code: 802, status, message: '已扫码，请在手机确认' };
    return { provider: 'kugou', code: 801, status: Number.isFinite(status) ? status : 1, message: '请使用酷狗音乐扫码' };
  }

  // ---------- 字段映射 ----------
  function mapArtists(raw) {
    return (raw || [])
      .map(a => ({ id: a && (a.id || a.singerid), mid: a && (a.hash || a.singerhash), name: (a && (a.name || a.singername)) || '' }))
      .filter(a => a.name);
  }

  function normalizeKugouImageUrl(url, size) {
    const px = String(size || 480);
    return String(url || '').replace('{size}', px).replace(/\/\d+$/, '/' + px);
  }

  function mapSong(s) {
    s = s || {};
    const hash = s.hash || s.songhash || s.audio_id || '';
    const albumId = s.album_id || s.albumid || s.album_audio_id || '';
    const authors = Array.isArray(s.authors) ? s.authors.map(a => ({ id: a.author_id, name: a.author_name })) : [];
    const artists = mapArtists(s.singers || s.singer || authors);
    const albumName = s.album_name || s.albumname || (s.album && s.album.album_name) || '';
    const cover = normalizeKugouImageUrl(
      (s.trans_param && (s.trans_param.album_img || s.trans_param.union_cover)) || s.album_img || s.imgUrl || s.pic || '',
      480
    );
    const privilege = Number(s.privilege || s['128privilege'] || s.pay_type || 0) || 0;
    return {
      provider: 'kugou',
      source: 'kugou',
      type: 'kugou',
      id: hash,
      hash,
      songHash: hash,
      albumAudioId: s.album_audio_id || s.album_audio_id === 0 ? String(s.album_audio_id) : '',
      albumId: String(albumId),
      name: s.song || s.songname || s.songName || s.name || '',
      artist: artists.map(a => a.name).join(' / ') || s.singername || s.singerName || s.author_name || '',
      artists,
      artistId: artists[0] && (artists[0].id || artists[0].mid),
      album: albumName,
      albumMid: '',
      cover,
      duration: s.timeLength != null ? (Number(s.timeLength) || 0) : ((Number(s.timelength || s.duration) || 0) * 1000),
      fee: s.is_free === 0 || Number(s.pay_type || 0) > 0 || privilege > 0 ? 1 : 0,
      playable: false,
    };
  }

  function mapPlaylist(pl) {
    pl = pl || {};
    const id = pl.global_collection_id || pl.global_collectionid || pl.collection_id || pl.list_create_gid || pl.specialid || pl.specialidstr || pl.id || pl.listid;
    // gateway 私有歌单（get_all_list）字段名与公开 special 接口不同：
    // 封面为 pic（含 {size} 占位符），歌曲数为 m_count，创建者为 list_create_username。
    const rawCover = pl.pic || pl.img || pl.picurl || pl.imgurl || pl.cover || pl.create_user_pic || '';
    return {
      provider: 'kugou',
      source: 'kugou',
      type: 'playlist',
      id: id ? String(id) : '',
      name: pl.specialname || pl.name || pl.title || '',
      cover: rawCover ? normalizeKugouImageUrl(rawCover, 240) : '',
      trackCount: Number(pl.songcount || pl.song_count || pl.total || pl.m_count || pl.count || 0) || 0,
      playCount: pl.playcount || pl.play_count || 0,
      creator: pl.nickname || pl.username || pl.list_create_username || (pl.user && pl.user.username) || '酷狗音乐',
      subscribed: !!(pl.iscollect || pl.collect),
      specialType: Number(pl.specialtype || 0) || 0,
    };
  }

  function mapComplexSearchSong(item) {
    item = item || {};
    return mapSong({
      hash: item.FileHash || item.HQFileHash || item.SQFileHash || item.ResFileHash || item.hash,
      album_audio_id: item.Audioid || item.audio_id,
      album_id: item.AlbumID || item.album_id,
      song: item.SongName || item.songname,
      singers: item.Singers ? item.Singers.map(s => ({ id: s.id, name: s.name, hash: s.hash })) : [],
      singername: item.SingerName || item.singername,
      album_name: item.AlbumName || item.album_name,
      duration: item.Duration || item.duration,
      trans_param: { album_img: item.Image ? String(item.Image).replace('{size}', '480') : '' },
      album_img: item.Image ? String(item.Image).replace('{size}', '480') : '',
      is_free: item.PayInfo ? item.PayInfo.play_adroid : 1,
    });
  }

  async function fetchM3wsSongInfo(songHash, albumId, albumAudioId) {
    const now = Date.now();
    const obj = parseCookieString(kugouCookie);
    const params = {
      album_audio_id: albumAudioId || '',
      album_id: albumId || '',
      cmd: 'playInfo',
      hash: String(songHash || '').trim(),
      timelength: 0,
      srcappid: 2919,
      clientver: 2000,
      clienttime: now,
      mid: kugouMid || obj.mid || String(now),
      uuid: kugouMid || obj.mid || String(now),
      dfid: kugouDfid || obj.dfid || '-',
      appid: 1058,
      from: 'mkugou',
      apiver: 2,
      platid: 4,
    };
    const uid = userId();
    const token = loginToken();
    const vip = vipToken();
    if (uid) { params.uid = uid; params.userid = uid; }
    if (token) params.token = token;
    if (vip) params.vip_token = vip;
    params.signature = signWeb(params).toUpperCase();
    const u = new URL('https://m3ws.kugou.com/v1/song/info');
    Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') u.searchParams.set(k, String(params[k]));
    });
    const text = await requestText(u.toString(), {
      headers: {
        ...HEADERS,
        Referer: 'https://www.kugou.com/',
        Cookie: kugouCookie,
      },
    });
    return JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
  }

  async function fetchMobileSongInfo(songHash, albumId) {
    const u = new URL('https://m.kugou.com/app/i/getSongInfo.php');
    u.searchParams.set('cmd', 'playInfo');
    u.searchParams.set('hash', String(songHash || '').trim());
    if (albumId) u.searchParams.set('album_id', String(albumId));
    const uid = userId();
    const token = loginToken();
    const vip = vipToken();
    if (uid) u.searchParams.set('userid', uid);
    if (token) u.searchParams.set('token', token);
    if (vip) u.searchParams.set('vip_token', vip);
    const text = await requestText(u.toString(), {
      headers: {
        ...HEADERS,
        Referer: 'https://m.kugou.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      },
    });
    return JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
  }

  async function enrichKugouSearchSongs(songs) {
    songs = Array.isArray(songs) ? songs : [];
    const targets = songs.filter(s => s && s.hash && (!s.cover || !s.album || !s.artist)).slice(0, 8);
    if (!targets.length) return songs;
    await Promise.allSettled(targets.map(async song => {
      const info = await fetchMobileSongInfo(song.hash, song.albumId);
      const mapped = mapSong(info);
      if (mapped.cover && !song.cover) song.cover = mapped.cover;
      if (mapped.album && !song.album) song.album = mapped.album;
      if (mapped.artist && !song.artist) song.artist = mapped.artist;
      if (mapped.artists && mapped.artists.length && (!song.artists || !song.artists.length)) song.artists = mapped.artists;
      if (mapped.artistId && !song.artistId) song.artistId = mapped.artistId;
      if (mapped.duration && !song.duration) song.duration = mapped.duration;
      if (mapped.fee) song.fee = mapped.fee;
    }));
    return songs;
  }

  // ---------- 业务: 搜索 ----------
  async function handleSearch(keywords, limit, page) {
    const kw = String(keywords || '').trim();
    if (!kw) return [];
    const num = Math.max(1, Math.min(30, parseInt(limit || '20', 10) || 20));
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    // 复杂搜索接口字段较全，失败回退到 mobilecdn
    try {
      const json = await kugouRequest('https://complexsearch.kugou.com/v2/search/song', {
        keyword: kw,
        page: p,
        pagesize: num,
        bitfilter: '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20',
        showtype: '10',
        is_verified: '1',
        platform: 'WebFilter',
        encoding: 'utf8',
        token: '',
        clientver: '1116',
        vip_token: '',
        dfid: kugouDfid || '',
      }, { signed: false });
      const list = json && json.data && Array.isArray(json.data.lists) ? json.data.lists : [];
      if (list.length) {
        return enrichKugouSearchSongs(list.map(mapComplexSearchSong).filter(s => s.name && s.hash));
      }
    } catch (e) {
      console.warn('[KugouSearch] complexsearch failed:', e.message);
    }
    // 回退到不需要 signature 的 web 搜索接口。
    try {
      const json = await kugouRequest('https://songsearch.kugou.com/song_search_v2', {
        keyword: kw,
        page: p,
        pagesize: num,
        platform: 'WebFilter',
        clientver: '2000',
      }, { signed: false });
      const list = json && json.data && Array.isArray(json.data.lists) ? json.data.lists : [];
      if (list.length) return enrichKugouSearchSongs(list.map(mapComplexSearchSong).filter(s => s.name && s.hash));
    } catch (e) {
      console.warn('[KugouSearch] songsearch fallback failed:', e.message);
    }
    // 最后回退到 mobile 简单搜索。mobilecdn 的 HTTPS 证书在部分网络会错配，改用 mobileservice。
    const u = new URL('https://mobileservice.kugou.com/api/v3/search/song');
    u.searchParams.set('keyword', kw);
    u.searchParams.set('page', String(p));
    u.searchParams.set('pagesize', String(num));
    u.searchParams.set('format', 'json');
    u.searchParams.set('showtype', '10');
    const text = await requestText(u.toString(), { headers: HEADERS });
    const json = JSON.parse(text);
    const list = json && json.data && Array.isArray(json.data.info) ? json.data.info : [];
    return enrichKugouSearchSongs(list.map(mapSong).filter(s => s.name && s.hash));
  }

  function kugouPlaybackPermissionState(loginInfo, vip) {
    loginInfo = loginInfo || {};
    const hasLogin = !!loginInfo.loggedIn;
    const hasVip = !!(loginInfo.isVip || loginInfo.isSvip || loginInfo.vipLevel === 'vip' || loginInfo.vipLevel === 'svip' || Number(loginInfo.vipType || 0) > 0);
    return {
      loggedIn: hasLogin,
      vipType: loginInfo.vipType || 0,
      vipLevel: loginInfo.vipLevel || 'none',
      isVip: hasVip,
      isSvip: !!loginInfo.isSvip,
      vipLabel: loginInfo.vipLabel || (hasVip ? 'VIP' : '无VIP'),
      hasVipToken: !!vip,
    };
  }

  // ---------- 业务: 歌曲播放地址 ----------
  async function handleSongUrl(hash, albumId, qualityPreference, albumAudioId) {
    const songHash = String(hash || '').trim();
    if (!songHash) return { provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH', message: 'Missing kugou song hash' };
    const album = String(albumId || '').trim();
    const audioId = String(albumAudioId || '').trim();
    const requestedQuality = normalizeQualityPreference(qualityPreference);
    const loginInfo = await getLoginInfo();
    const token = loginToken();
    const vip = vipToken();
    const permissionState = kugouPlaybackPermissionState(loginInfo, vip);

    // 优先走 m3ws 官方移动接口。它使用 Web signature，实测能返回 VIP5 账号可播地址；
    // 旧 play/index key 算法在当前接口上返回 Bad key，不能再作为首选。
    const m3wsErrorMessages = [];
    try {
      const m3 = await fetchM3wsSongInfo(songHash, album, audioId);
      if (m3 && (m3.error || m3.err_code || m3.errcode || m3.error_msg || m3.message)) {
        m3wsErrorMessages.push([m3.err_code, m3.errcode, m3.error_msg, m3.message, m3.error].filter(Boolean).join(' '));
      }
      const m3Data = m3 && (m3.data || m3.info || m3);
      const directUrl = m3Data && (m3Data.play_url || m3Data.playUrl || m3Data.url || (Array.isArray(m3Data.backup_url) && m3Data.backup_url[0]) || (Array.isArray(m3Data.backupUrl) && m3Data.backupUrl[0]));
      if (directUrl) {
        return {
          provider: 'kugou',
          url: Array.isArray(directUrl) ? directUrl[0] : directUrl,
          trial: false,
          playable: true,
          level: m3Data.extName || m3Data.fileExt || '',
          quality: m3Data.bitRate ? String(m3Data.bitRate) : (m3Data.quality || ''),
          hash: songHash,
          ...permissionState,
          requestedQuality,
        };
      }
    } catch (e) {
      m3wsErrorMessages.push(e && e.message ? e.message : String(e));
      console.warn('[KugouSongUrl] m3ws song info failed:', e.message);
    }

    const hashKey = signedKey({
      'hash': songHash,
      'dfid': kugouDfid || '0'.repeat(24),
      'mid': kugouMid || '0'.repeat(24),
      'userid': userId() || '0',
      'token': token,
      'vip_token': vip,
      'appid': '1014',
      'clientver': '1116',
      'srcappid': '2919',
      'clienttime': Math.floor(Date.now() / 1000),
      'platform': '10',
      'album_id': album || '',
      'area_code': '1',
    });
    let json = null;
    let playIndexError = null;
    const playIndexErrorMessages = [];
    try {
      json = await kugouRequest('https://wwwapi.kugou.com/play/index', {
        hash: songHash,
        album_id: album || '',
        mid: kugouMid || '0'.repeat(24),
        dfid: kugouDfid || '0'.repeat(24),
        userid: userId() || '0',
        token,
        vip_token: vip,
        key: hashKey,
        clientver: '1116',
        srcappid: '2919',
        clienttime: Math.floor(Date.now() / 1000),
        platform: '10',
        appid: '1014',
      }, { signed: false });
    } catch (e) {
      playIndexError = e;
    }
    if (json && (json.error || json.error_msg || json.message || json.err_code || json.errcode)) {
      playIndexErrorMessages.push(String(json.error_msg || json.message || json.error || json.err_code || json.errcode));
    }
    const urlInfo = json && json.data && Array.isArray(json.data.url) ? json.data.url : [];
    // 按音质等级挑选：flac > 320 mp3 > 128 mp3
    const order = ['flac', 'high', '320', '128', 'ape'];
    let pick = null;
    for (const lv of order) {
      pick = urlInfo.find(item => item && item.format && item.format.toLowerCase().includes(lv)) || pick;
      if (pick) break;
    }
    pick = pick || urlInfo[0];
    if (pick && pick.url) {
      return {
        provider: 'kugou',
        url: pick.url,
        trial: false,
        playable: true,
        level: pick.format || '',
        quality: pick.quality || pick.format || '',
          hash: songHash,
          ...permissionState,
          requestedQuality,
      };
    }
    // 备用：trackercdn 直接拼
    try {
      const key = crypto.createHash('md5').update(songHash.toLowerCase() + 'kgcloudv2').digest('hex').toUpperCase();
      const u = `https://trackercdn.kugou.com/i/v2/?key=${key}&hash=${songHash}&br=hq&appid=1005&pid=2&behavior=play&cmd=25&filename=${songHash}.mp3`;
      const text = await requestText(u, { headers: HEADERS });
      const fallback = JSON.parse(text);
      if (fallback && Array.isArray(fallback.url) && fallback.url[0] && fallback.url[0].url) {
        return {
          provider: 'kugou',
          url: fallback.url[0].url,
          trial: false,
          playable: true,
          level: fallback.url[0].format || '',
          quality: 'hq',
          hash: songHash,
          ...permissionState,
          requestedQuality,
        };
      }
    } catch (e) {
      console.warn('[KugouSongUrl] trackercdn fallback failed:', e.message);
    }
    let mobileInfo = null;
    try {
      mobileInfo = await fetchMobileSongInfo(songHash, album);
      const directUrl = mobileInfo && (mobileInfo.url || (Array.isArray(mobileInfo.backup_url) && mobileInfo.backup_url[0]));
      if (directUrl) {
        return {
          provider: 'kugou',
          url: directUrl,
          trial: false,
          playable: true,
          level: mobileInfo.extName || '',
          quality: mobileInfo.bitRate ? String(mobileInfo.bitRate) : '',
          hash: songHash,
          ...permissionState,
          requestedQuality,
        };
      }
    } catch (e) {
      console.warn('[KugouSongUrl] mobile play info failed:', e.message);
    }
    const qualityHashMap = mobileInfo && mobileInfo.extra || {};
    const preferredHashes = [];
    if (requestedQuality === 'hires' || requestedQuality === 'jymaster') preferredHashes.push(qualityHashMap.highhash, qualityHashMap.sqhash, qualityHashMap['320hash']);
    else if (requestedQuality === 'lossless') preferredHashes.push(qualityHashMap.sqhash, qualityHashMap['320hash']);
    else if (requestedQuality === 'exhigh') preferredHashes.push(qualityHashMap['320hash'], qualityHashMap.sqhash);
    preferredHashes.push(qualityHashMap['128hash']);
    for (const altHash of preferredHashes.filter(Boolean)) {
      if (String(altHash).toUpperCase() === songHash.toUpperCase()) continue;
      try {
        const altInfo = await fetchMobileSongInfo(altHash, album);
        const directUrl = altInfo && (altInfo.url || (Array.isArray(altInfo.backup_url) && altInfo.backup_url[0]));
        if (directUrl) {
          return {
            provider: 'kugou',
            url: directUrl,
            trial: false,
            playable: true,
            level: altInfo.extName || '',
            quality: altInfo.bitRate ? String(altInfo.bitRate) : '',
            hash: altHash,
            ...permissionState,
            requestedQuality,
          };
        }
      } catch (e) {}
    }
    const serviceErrorText = [
      playIndexError && playIndexError.message,
      ...playIndexErrorMessages,
      mobileInfo && (mobileInfo.error || mobileInfo.error_msg || mobileInfo.message),
      ...m3wsErrorMessages,
    ].filter(Boolean).join(' ');
    // 带 cookie/token 鉴权的 mobile 接口是唯一权威来源：它明确返回 pay_type/privilege/"需要付费"
    // 时，说明是版权/会员付费限制，而非签名鉴权问题。此判定优先于签名噪音（如 m3ws 的 30001 data not found）。
    const paid = mobileInfo && (Number(mobileInfo.pay_type || 0) > 0 || Number(mobileInfo.privilege || 0) > 0 || /付费|会员|VIP/i.test(String(mobileInfo.error || '')));
    // 注意：30001 是 m3ws "data not found" 噪音，不代表签名失败，不纳入签名判定。
    const signatureUnavailable = /Bad key|signature|\bsign\b|authorization|unauthorized|鉴权|签名/i.test(serviceErrorText);
    // 已登录 VIP 却拿不到付费歌地址：这是本播放器对酷狗客户端取址能力适配未完成所致，
    // 并非用户账号权限不足（同一账号在酷狗官方客户端可正常播放）。如实说明并引导换源，
    // 避免给用户"你的会员不够"的错误归因。
    const vipButUnavailable = paid && permissionState.isVip;
    const reason = vipButUnavailable
      ? 'client_playback_unsupported'
      : (paid
        ? 'paid_required'
        : (signatureUnavailable ? 'signature_or_authorization_unavailable' : 'url_unavailable'));
    const message = reason === 'client_playback_unsupported'
      ? '酷狗会员歌曲暂时无法在本播放器取得播放地址（客户端取址适配未完成），可切换到 QQ 音乐或网易云音源播放'
      : (reason === 'paid_required'
        ? '酷狗当前歌曲需要会员或购买，请登录酷狗会员账号，或切换到其他音源'
        : (reason === 'signature_or_authorization_unavailable'
          ? '酷狗播放接口暂未取得可播放地址，可切换到其他音源'
          : '酷狗未返回可播放地址，可能受版权限制，可切换到其他音源'));
    const action = reason === 'paid_required' ? 'login' : 'switch_source';
    return {
      provider: 'kugou',
      url: '',
      playable: false,
      error: 'KUGOU_URL_UNAVAILABLE',
      reason,
      message,
      restriction: playbackRestriction('kugou', reason, message, action, { playIndexError: playIndexError && playIndexError.message, vipLevel: permissionState.vipLevel || 'none', hasVipToken: permissionState.hasVipToken }),
      ...permissionState,
      requestedQuality,
    };
  }

  // ---------- 业务: 歌词 ----------
  async function handleLyric(hash) {
    const songHash = String(hash || '').trim();
    if (!songHash) return { provider: 'kugou', error: 'Missing kugou song hash', lyric: '' };
    // 1. 先取搜索结果里的 album_id / 歌名
    let songName = '';
    let durationMs = 0;
    try {
      const searchJson = await kugouRequest('https://msearchcdn.kugou.com/api/v3/search/song', {
        keyword: songHash,
        pagesize: 1,
        page: 1,
        hash: songHash,
      }, { signed: false });
      const info = searchJson && searchJson.data && searchJson.data.info && searchJson.data.info[0];
      if (info) {
        songName = info.songname || info.song || '';
        durationMs = (Number(info.duration) || 0) * 1000;
      }
    } catch (e) {
      console.warn('[KugouLyric] search album failed:', e.message);
    }
    // 2. 调歌词接口
    let lyricText = '';
    let transText = '';
    let romaText = '';
    try {
      const u = new URL('https://m.kugou.com/app/i/krc.php');
      u.searchParams.set('keyword', songName || songHash);
      u.searchParams.set('hash', songHash);
      u.searchParams.set('timelength', String(Math.floor(durationMs / 1000) || 0));
      u.searchParams.set('cmd', '100');
      u.searchParams.set('clientver', '1116');
      u.searchParams.set('clientmobi', 'android');
      u.searchParams.set('mid', kugouMid || '');
      u.searchParams.set('dfid', kugouDfid || '');
      const text = await requestText(u.toString(), { headers: { ...HEADERS, Referer: 'https://m.kugou.com/' } });
      lyricText = String(text || '').replace(/^callback\(([\s\S]*)\);?$/, '$1').trim();
      if (/^\{/.test(lyricText)) {
        const json = JSON.parse(lyricText);
        lyricText = decodeQQLyricText(json.lyric || json.content || '');
        transText = decodeQQLyricText(json.translate || json.tlyric || '');
        romaText = decodeQQLyricText(json.romalrc || json.roma || '');
      }
    } catch (e) {
      console.warn('[KugouLyric] krc.php failed:', e.message);
    }
    return {
      provider: 'kugou',
      hash: songHash,
      lyric: lyricText,
      tlyric: transText,
      yrc: '',
      qrc: '',
      roma: romaText,
      source: lyricText ? 'kugou-krc' : 'kugou-empty',
    };
  }

  // ---------- 业务: 评论 ----------
  function mapComment(raw) {
    raw = raw || {};
    const user = raw.user || {};
    return {
      id: raw.p_id || raw.comment_id || raw.id || '',
      content: decodeHtmlEntities(raw.content || raw.message || ''),
      likedCount: Number(raw.like || raw.likenum || raw.praise_count || 0) || 0,
      time: (Number(raw.addtime || raw.create_time || 0) || 0) * 1000,
      user: {
        id: String(user.id || raw.userid || ''),
        nickname: decodeHtmlEntities(user.name || user.nickname || raw.username || '酷狗用户'),
        avatar: user.headimg || user.avatar || raw.headimg || '',
      },
    };
  }

  async function handleSongComments(hash, limit, offset) {
    const songHash = String(hash || '').trim();
    if (!songHash) return { provider: 'kugou', error: 'Missing kugou song hash', comments: [] };
    const num = Math.max(6, Math.min(50, parseInt(limit || '20', 10) || 20));
    const page = Math.max(1, Math.floor((offset || 0) / num) + 1);
    try {
      const json = await kugouRequest('https://comment.service.kugou.com/v1/pc/rank/get', {
        appid: '1005',
        code: 'fc4be23b4e972707f44b856e6090a6ed',
        clientver: '1116',
        p: String(page),
        ps: String(num),
        extdata: songHash,
        is_hot: '1',
      }, { signed: false });
      const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
      const comments = list.map(mapComment).filter(c => c.content);
      return { provider: 'kugou', total: (json && json.data && json.data.count) || comments.length, comments };
    } catch (e) {
      return { provider: 'kugou', error: e.message, comments: [] };
    }
  }

  // ---------- 业务: 歌手详情 ----------
  async function handleArtistDetail(singerId, limit) {
    const id = String(singerId || '').trim();
    const num = Math.max(10, Math.min(80, parseInt(limit || '36', 10) || 36));
    if (!id) return { provider: 'kugou', error: 'MISSING_SINGER_ID', artist: null, songs: [] };
    try {
      const json = await kugouRequest('https://mobiles.kugou.com/api/v5/singer/song', {
        singerid: id,
        page: 1,
        pagesize: num,
        platform: 'WebFilter',
      }, { signed: false });
      const info = json && json.data || {};
      const rawSongs = Array.isArray(info.list) ? info.list : (Array.isArray(info.songs) ? info.songs : []);
      const songs = rawSongs.map(item => mapSong(item && (item.songinfo || item))).filter(s => s.name && s.hash);
      return {
        provider: 'kugou',
        artist: {
          provider: 'kugou',
          id,
          name: info.singername || (songs[0] && songs[0].artist) || '酷狗歌手',
          avatar: info.imgurl || info.avatar || '',
          musicSize: Number(info.songcount || 0) || songs.length,
        },
        total: Number(info.total || 0) || songs.length,
        songs,
      };
    } catch (e) {
      return { provider: 'kugou', error: e.message, artist: null, songs: [] };
    }
  }

  // 用户私有歌单曲目的 name 字段是 "歌手 - 歌名" 合并格式，需拆分。
  function mapCollectionSong(item) {
    item = item || {};
    const combined = String(item.name || item.filename || '').trim();
    let artist = '';
    let songName = combined;
    const sep = combined.indexOf(' - ');
    if (sep > 0) {
      artist = combined.slice(0, sep).trim();
      songName = combined.slice(sep + 3).trim();
    }
    return mapSong({
      hash: item.hash,
      album_audio_id: item.audio_id,
      album_id: item.album_id,
      song: songName,
      singername: artist,
      timelength: item.timelen || item.duration,
      extname: item.extname,
    });
  }

  // 私有歌单（global_collection_id）走 pubsongs 接口，用 web signature 取曲目。
  // mobiles v5/special/song 只认数字 specialid，对 collection_ 前缀 id 取不到歌。
  async function fetchCollectionTracks(globalCollectionId) {
    const obj = parseCookieString(kugouCookie);
    const params = {
      appid: '1058',
      clientver: '11409',
      clienttime: Math.floor(Date.now() / 1000),
      mid: kugouMid || obj.mid || '-',
      dfid: kugouDfid || obj.dfid || '-',
      uuid: kugouMid || obj.mid || '-',
      global_collection_id: globalCollectionId,
      page: 1,
      pagesize: 300,
      begin_idx: 0,
      area_code: 1,
      type: 0,
      module: 'CloudMusic',
      userid: userId() || '0',
      token: loginToken() || '',
      srcappid: '2919',
    };
    params.signature = signWeb(params);
    const u = new URL('https://pubsongscdn.kugou.com/v2/get_other_list_file');
    Object.keys(params).forEach(k => {
      if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
    });
    const text = await requestText(u.toString(), { headers: { ...HEADERS, Cookie: kugouCookie } });
    const json = JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
    const info = json && json.data && Array.isArray(json.data.info) ? json.data.info : [];
    return info.map(mapCollectionSong).filter(s => s.name && s.hash);
  }

  // ---------- 业务: 歌单内曲目 ----------
  async function handlePlaylistTracks(specialId) {
    const id = String(specialId || '').trim();
    if (!id) return { provider: 'kugou', error: 'Missing kugou special id', tracks: [] };
    // 私有歌单 id 形如 collection_3_<uid>_<n>_0，需走 pubsongs 接口。
    if (/^collection_/i.test(id)) {
      try {
        const tracks = await fetchCollectionTracks(id);
        return {
          provider: 'kugou',
          playlist: { provider: 'kugou', id, name: '', cover: '', trackCount: tracks.length },
          tracks,
        };
      } catch (e) {
        return { provider: 'kugou', error: e.message, tracks: [] };
      }
    }
    try {
      const json = await kugouRequest('https://mobiles.kugou.com/api/v5/special/song', {
        specialid: id,
        page: 1,
        pagesize: 100,
        platform: 'WebFilter',
      }, { signed: false });
      const info = json && json.data || {};
      const rawSongs = Array.isArray(info.list) ? info.list : [];
      const tracks = rawSongs.map(item => mapSong(item && (item.songinfo || item))).filter(s => s.name && s.hash);
      return {
        provider: 'kugou',
        playlist: {
          provider: 'kugou',
          id,
          name: info.specialname || '',
          cover: info.imgurl || '',
          trackCount: tracks.length,
        },
        tracks,
      };
    } catch (e) {
      return { provider: 'kugou', error: e.message, tracks: [] };
    }
  }

  function normalizeKugouVip(cookieObj, user, data) {
    cookieObj = cookieObj || {};
    user = user || {};
    data = data || {};
    const vipType = Number(
      user.vipType || user.vip_type || user.viplevel || user.vip_level ||
      data.vipType || data.vip_type || data.viplevel || data.vip_level ||
      cookieObj.vipType || cookieObj.vip_type || cookieObj.viplevel || cookieObj.vip_level || cookieObj.vip || 0
    ) || 0;
    const text = [user.vipLevel, user.vip_level, data.vipLevel, data.vip_level, cookieObj.vipLevel, cookieObj.vip_level, cookieObj.vip_label]
      .filter(Boolean).join(' ').toLowerCase();
    const isSvip = vipType >= 7 || user.isSvip === true || user.is_svip === true || data.isSvip === true || data.is_svip === true || /svip|super|豪华|超级/.test(text);
    const isVip = isSvip || vipType > 0 || user.isvip === 1 || user.is_vip === 1 || user.isVip === true || data.isvip === 1 || data.is_vip === 1 || data.isVip === true || /vip|会员/.test(text);
    const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
    return { vipType: vipType || (isVip ? 1 : 0), vipLevel, isVip, isSvip, vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP') };
  }

  // ---------- 业务: 登录态 ----------
  function normalizeProfile(body, cookieObj) {
    cookieObj = cookieObj || parseCookieString(kugouCookie);
    const data = (body && (body.data || body.info || body.user)) || {};
    const user = data.user || data.info || data.base || data || {};
    const packed = parsePackedKugouCookie(cookieObj);
    const userid = userId() || user.userid || user.user_id || user.id || cookieObj.KugooID || packed.KugooID || '';
    const cookieName = safeDecodeCookieValue(packed.NickName || cookieObj.NickName || cookieObj.nickname || cookieObj.UserName || packed.UserName || '');
    const nickname = user.nickname || user.nick_name || user.username || user.name || data.nickname || cookieName || '酷狗用户';
    const avatar = user.avatar || user.headimg || user.head_img || user.pic || data.avatar || data.headimg || packed.Pic || '';
    const vip = normalizeKugouVip(cookieObj, user, data);
    return {
      provider: 'kugou',
      loggedIn: !!(userid && kugouCookie),
      preview: false,
      userId: String(userid),
      nickname,
      avatar,
      ...vip,
      hasCookie: !!kugouCookie,
      profileSource: nickname !== '酷狗用户' ? 'kugou-profile' : (kugouCookie ? 'cookie' : 'fallback'),
    };
  }

  async function getLoginInfo() {
    if (!kugouCookie) return { provider: 'kugou', loggedIn: false, hasCookie: false };
    const obj = parseCookieString(kugouCookie);
    kugouDfid = obj.kugou_dfid || obj.dfid || kugouDfid;
    kugouMid = obj.mid || obj.kugou_mid || kugouMid;
    const userid = userId();
    if (!userid) return { provider: 'kugou', loggedIn: false, hasCookie: true };
    let fallback = normalizeProfile(null, obj);
    if (fallback.loggedIn && !fallback.isVip && loginToken()) {
      try {
        const refreshed = await refreshAndroidLoginToken();
        if (refreshed) fallback = normalizeProfile(null, parseCookieString(kugouCookie));
      } catch (e) {
        console.warn('[KugouLogin] vip token refresh failed:', e.message);
      }
    }
    // 酷狗旧 userservice rsex 接口已返回 404；先用 cookie/token 保底确保账号 ID 同步，歌单走 gateway 私有接口。
    return fallback;
  }

  function extractKugouPlaylistList(json) {
    const data = json && (json.data || json.info || json.result) || {};
    const candidates = [
      data.list,
      data.lists,
      data.info,
      data.data,
      data.create_list,
      data.collect_list,
      json && json.list,
    ];
    let list = [];
    candidates.forEach(item => {
      if (Array.isArray(item)) list = list.concat(item);
      else if (item && Array.isArray(item.list)) list = list.concat(item.list);
    });
    return list;
  }

  async function fetchPublicMobileUserPlaylists(userIdValue) {
    const uid = String(userIdValue || '').trim();
    if (!uid) return [];
    const u = new URL('http://m.kugou.com/plist/index/' + encodeURIComponent(uid));
    u.searchParams.set('json', 'true');
    u.searchParams.set('page', '1');
    u.searchParams.set('pagesize', '80');
    const text = await requestText(u.toString(), {
      headers: {
        ...HEADERS,
        Referer: 'http://m.kugou.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        Cookie: kugouCookie,
      },
    });
    const json = JSON.parse(text.replace(/^callback\(([\s\S]*)\);?$/, '$1').trim());
    const info = json && json.plist && json.plist.list && json.plist.list.info;
    return Array.isArray(info) ? info : [];
  }

  // ---------- 业务: 用户歌单 ----------
  async function handleUserPlaylists() {
    const info = await getLoginInfo();
    if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'kugou', playlists: [] };
    const token = loginToken();
    if (!token) return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists: [], missingToken: true, privateUnavailable: true };
    try {
      const json = await kugouGatewayRequest('/v7/get_all_list', {
        plat: 1,
        userid: Number(info.userId),
        token,
      }, {
        userid: String(info.userId),
        token,
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 80,
      }, 'cloudlist.service.kugou.com');
      let list = extractKugouPlaylistList(json);
      if (!Array.isArray(list) || !list.length) {
        return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists: [], privateUnavailable: true, emptyPrivateList: true };
      }
      const seen = new Set();
      const playlists = list.map(pl => mapPlaylist(pl)).filter(pl => {
        if (!pl.id || !pl.name || seen.has(pl.id)) return false;
        seen.add(pl.id);
        return true;
      });
      return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists };
    } catch (e) {
      console.warn('[KugouUserPlaylists] gateway failed:', e.message);
      try {
        try { await registerAndroidDevice(); } catch (devErr) { console.warn('[KugouUserPlaylists] register device failed:', devErr.message); }
        const refreshed = await refreshAndroidLoginToken();
        if (refreshed) {
          const refreshedToken = loginToken();
          const json = await kugouGatewayRequest('/v7/get_all_list', {
            plat: 1,
            userid: Number(info.userId),
            token: refreshedToken,
          }, {
            userid: String(info.userId),
            token: refreshedToken,
            total_ver: 979,
            type: 2,
            page: 1,
            pagesize: 80,
          }, 'cloudlist.service.kugou.com');
          const list = extractKugouPlaylistList(json);
          const seen = new Set();
          const playlists = list.map(pl => mapPlaylist(pl)).filter(pl => {
            if (!pl.id || !pl.name || seen.has(pl.id)) return false;
            seen.add(pl.id);
            return true;
          });
          if (playlists.length) return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists, privateSynced: true };
        }
      } catch (retryErr) {
        console.warn('[KugouUserPlaylists] token refresh retry failed:', retryErr.message);
      }
      return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists: [], privateUnavailable: true, error: e.message };
    }
  }

  // ---------- cookie 写入（外部登录路由用） ----------
  function setCookie(rawCookie) {
    const normalized = normalizeCookieHeader(rawCookie);
    if (!normalized) return '';
    persistCookie(normalized);
    syncFingerprint(normalized);
    return normalized;
  }
  function clearCookie() {
    persistCookie('');
    kugouDfid = '';
    kugouMid = '';
  }

  return {
    handleSearch,
    handleSongUrl,
    handleLyric,
    handleSongComments,
    handleArtistDetail,
    handlePlaylistTracks,
    handleUserPlaylists,
    getLoginInfo,
    createQrLogin,
    checkQrLogin,
    setCookie,
    clearCookie,
    hasCookie: () => !!kugouCookie,
  };
}

module.exports = { createKugouProvider };
