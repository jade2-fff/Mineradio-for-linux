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
    Accept: 'application/json, text/plain, */*',
  };

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

  // ---------- 字段映射 ----------
  function mapArtists(raw) {
    return (raw || [])
      .map(a => ({ id: a && (a.id || a.singerid), mid: a && (a.hash || a.singerhash), name: (a && (a.name || a.singername)) || '' }))
      .filter(a => a.name);
  }

  function mapSong(s) {
    s = s || {};
    const hash = s.hash || s.songhash || s.audio_id || '';
    const albumId = s.album_id || s.albumid || s.album_audio_id || '';
    const artists = mapArtists(s.singers || s.singer || []);
    const albumName = s.album_name || s.albumname || (s.album && s.album.album_name) || '';
    return {
      provider: 'kugou',
      source: 'kugou',
      type: 'kugou',
      id: hash,
      hash,
      songHash: hash,
      albumAudioId: s.album_audio_id || '',
      albumId: String(albumId),
      name: s.song || s.songname || s.name || '',
      artist: artists.map(a => a.name).join(' / ') || s.singername || '',
      artists,
      artistId: artists[0] && (artists[0].id || artists[0].mid),
      album: albumName,
      albumMid: '',
      cover: s.trans_param && s.trans_param.album_img ? (s.trans_param.album_img.replace(/\/\d+$/, '/480')) : (s.album_img || s.pic || ''),
      duration: (Number(s.timelength || s.duration) || 0) * (s.timelength ? 1000 : 1),
      fee: s.is_free === 0 ? 1 : 0,
      playable: false,
    };
  }

  function mapPlaylist(pl) {
    pl = pl || {};
    const id = pl.specialid || pl.specialidstr || pl.id || pl.listid;
    return {
      provider: 'kugou',
      source: 'kugou',
      type: 'playlist',
      id: id ? String(id) : '',
      name: pl.specialname || pl.name || pl.title || '',
      cover: pl.img || pl.picurl || pl.imgurl || pl.cover || '',
      trackCount: pl.songcount || pl.song_count || pl.total || 0,
      playCount: pl.playcount || pl.play_count || 0,
      creator: pl.nickname || pl.username || (pl.user && pl.user.username) || '酷狗音乐',
      subscribed: !!(pl.iscollect || pl.collect),
      specialType: Number(pl.specialtype || 0) || 0,
    };
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
        return list.map(item => mapSong({
          hash: item.FileHash,
          album_audio_id: item.Audioid,
          album_id: item.AlbumID,
          song: item.SongName,
          singers: item.Singers ? item.Singers.map(s => ({ id: s.id, name: s.name, hash: s.hash })) : [],
          album_name: item.AlbumName,
          duration: item.Duration,
          trans_param: { album_img: item.Image ? item.Image.replace('{size}', '480') : '' },
          is_free: item.PayInfo ? item.PayInfo.play_adroid : 1,
        })).filter(s => s.name && s.hash);
      }
    } catch (e) {
      console.warn('[KugouSearch] complexsearch failed:', e.message);
    }
    // 回退到 mobilecdn 简单搜索
    const u = new URL('https://mobilecdn.kugou.com/api/v3/search/song');
    u.searchParams.set('keyword', kw);
    u.searchParams.set('page', String(p));
    u.searchParams.set('pagesize', String(num));
    u.searchParams.set('format', 'json');
    u.searchParams.set('showtype', '10');
    const text = await requestText(u.toString(), { headers: HEADERS });
    const json = JSON.parse(text);
    const list = json && json.data && Array.isArray(json.data.info) ? json.data.info : [];
    return list.map(mapSong).filter(s => s.name && s.hash);
  }

  // ---------- 业务: 歌曲播放地址 ----------
  async function handleSongUrl(hash, albumId, qualityPreference) {
    const songHash = String(hash || '').trim();
    if (!songHash) return { provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH', message: 'Missing kugou song hash' };
    const album = String(albumId || '').trim();
    const requestedQuality = normalizeQualityPreference(qualityPreference);
    const hashKey = signedKey({
      'hash': songHash,
      'dfid': kugouDfid || '0'.repeat(24),
      'mid': kugouMid || '0'.repeat(24),
      'userid': userId() || '0',
      'token': '',
      'vip_token': '',
      'appid': '1014',
      'clientver': '1116',
      'srcappid': '2919',
      'clienttime': Math.floor(Date.now() / 1000),
      'platform': '10',
      'album_id': album || '',
      'area_code': '1',
    });
    let json;
    try {
      json = await kugouRequest('https://wwwapi.kugou.com/play/index', {
        hash: songHash,
        album_id: album || '',
        mid: kugouMid || '0'.repeat(24),
        dfid: kugouDfid || '0'.repeat(24),
        userid: userId() || '0',
        key: hashKey,
        clientver: '1116',
        srcappid: '2919',
        clienttime: Math.floor(Date.now() / 1000),
        platform: '10',
        appid: '1014',
      }, { signed: false });
    } catch (e) {
      return { provider: 'kugou', url: '', playable: false, error: 'KUGOU_URL_REQUEST_FAILED', message: e.message };
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
          requestedQuality,
        };
      }
    } catch (e) {
      console.warn('[KugouSongUrl] trackercdn fallback failed:', e.message);
    }
    return {
      provider: 'kugou',
      url: '',
      playable: false,
      error: 'KUGOU_URL_UNAVAILABLE',
      message: '酷狗未返回可播放地址，可能受版权或会员限制，可换源到网易云或 QQ',
      restriction: playbackRestriction('kugou', 'url_unavailable', '酷狗未返回可播放地址，可能受版权或会员限制', 'switch_source', {}),
      loggedIn: !!kugouCookie,
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

  // ---------- 业务: 歌单内曲目 ----------
  async function handlePlaylistTracks(specialId) {
    const id = String(specialId || '').trim();
    if (!id) return { provider: 'kugou', error: 'Missing kugou special id', tracks: [] };
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

  // ---------- 业务: 登录态 ----------
  function normalizeProfile(body, cookieObj) {
    cookieObj = cookieObj || parseCookieString(kugouCookie);
    const data = (body && (body.data || body.info || body.user)) || {};
    const user = data.user || data.info || data || {};
    const userid = userId() || user.userid || user.id || '';
    const nickname = user.nickname || user.name || user.username || '酷狗用户';
    const avatar = user.avatar || user.headimg || user.pic || '';
    const vipLevel = Number(user.viplevel || data.viplevel || cookieObj.viplevel || 0) || 0;
    const isVip = vipLevel > 0 || user.isvip === 1 || data.isvip === 1;
    return {
      provider: 'kugou',
      loggedIn: !!(userid && kugouCookie),
      preview: false,
      userId: String(userid),
      nickname,
      avatar,
      vipType: isVip ? 1 : 0,
      vipLevel: isVip ? 'vip' : 'none',
      isVip,
      isSvip: vipLevel >= 7,
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
    const fallback = normalizeProfile(null, obj);
    try {
      const json = await kugouRequest('https://userservice.kugou.com/rsex/v1/get_userinfo_ext', {
        userid,
        kugouid: userid,
        plat: 0,
      }, { signed: false });
      return normalizeProfile(json, obj);
    } catch (e) {
      console.warn('[KugouLogin] profile check failed:', e.message);
      return { ...fallback, profileUnavailable: true };
    }
  }

  // ---------- 业务: 用户歌单 ----------
  async function handleUserPlaylists() {
    const info = await getLoginInfo();
    if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'kugou', playlists: [] };
    try {
      const json = await kugouRequest('https://userservice.kugou.com/rsex/v1/special_list', {
        userid: info.userId,
        type: 'collect',
        page: 1,
        pagesize: 80,
        plat: 0,
      }, { signed: false });
      const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
      const created = list.filter(pl => Number(pl.status) === 1).map(mapPlaylist);
      const collected = list.filter(pl => Number(pl.status) === 0 || Number(pl.iscollect) === 1).map(pl => {
        const mapped = mapPlaylist(pl);
        mapped.subscribed = true;
        return mapped;
      });
      const seen = new Set();
      const playlists = created.concat(collected).filter(pl => {
        if (!pl.id || !pl.name || seen.has(pl.id)) return false;
        seen.add(pl.id);
        return true;
      });
      return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists };
    } catch (e) {
      console.warn('[KugouUserPlaylists] failed:', e.message);
      return { loggedIn: true, provider: 'kugou', userId: info.userId, playlists: [] };
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
    setCookie,
    clearCookie,
    hasCookie: () => !!kugouCookie,
  };
}

module.exports = { createKugouProvider };
