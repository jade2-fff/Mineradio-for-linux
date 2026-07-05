const assert = require('assert');
const path = require('path');
const { createKugouProvider } = require('./kugou');

function makeProvider(requests) {
  return createKugouProvider({
    requestText: async (url) => {
      requests.push(new URL(url));
      if (url.includes('complexsearch.kugou.com')) {
        return JSON.stringify({ status: 0, error_code: 20006, error_msg: 'err signature', data: { lists: [] } });
      }
      if (url.includes('songsearch.kugou.com')) {
        return JSON.stringify({
          status: 1,
          error_code: 0,
          data: {
            lists: [{
              FileHash: 'ABCDEF123456',
              Audioid: 123,
              AlbumID: 456,
              SongName: '晴天',
              SingerName: '周杰伦',
              AlbumName: '叶惠美',
              Duration: 269,
              PayInfo: { play_adroid: 1 },
            }],
          },
        });
      }
      if (url.includes('m.kugou.com/app/i/getSongInfo.php')) {
        return JSON.stringify({
          hash: 'ABCDEF123456',
          songName: '晴天',
          singerName: '周杰伦',
          author_name: '周杰伦',
          album_name: '叶惠美',
          albumid: 456,
          album_img: 'http://imge.kugou.com/stdmusic/{size}/cover.jpg',
          timeLength: 269000,
          status: 1,
          errcode: 0,
        });
      }
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: () => ({}),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile: path.join(__dirname, '.tmp-kugou-search-test-cookie'),
  });
}

async function testSearchFallsBackWhenComplexSearchSignatureFails() {
  const requests = [];
  const kugou = makeProvider(requests);
  const songs = await kugou.handleSearch('周杰伦', 5);

  assert.strictEqual(requests[0].hostname, 'complexsearch.kugou.com');
  assert.strictEqual(requests[1].hostname, 'songsearch.kugou.com');
  assert.strictEqual(songs.length, 1);
  assert.strictEqual(songs[0].name, '晴天');
  assert.strictEqual(songs[0].artist, '周杰伦');
  assert.strictEqual(songs[0].hash, 'ABCDEF123456');
  assert.ok(songs[0].cover.includes('/480/cover.jpg'), 'Kugou search should backfill official cover from song info');
}

async function testPaidSongUrlIsUnavailableNotHttpFailure() {
  const requests = [];
  const kugou = createKugouProvider({
    requestText: async (url) => {
      requests.push(new URL(url));
      if (url.includes('m3ws.kugou.com/v1/song/info')) return JSON.stringify({ status: 0, error_msg: 'unavailable' });
      if (url.includes('wwwapi.kugou.com/play/index')) {
        return '<!DOCTYPE html><title>404</title>';
      }
      if (url.includes('trackercdn.kugou.com')) {
        return JSON.stringify({ status: 0, error: 'Bad key' });
      }
      if (url.includes('m.kugou.com/app/i/getSongInfo.php')) {
        return JSON.stringify({ status: 0, errcode: 0, error: '需要付费', url: '', pay_type: 3, privilege: 10 });
      }
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: (provider, category, message, action, extra) => ({ provider, category, message, action, extra }),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile: path.join(__dirname, '.tmp-kugou-search-test-cookie'),
  });
  const result = await kugou.handleSongUrl('ABCDEF123456', '456', 'hires');
  assert.strictEqual(result.playable, false);
  assert.strictEqual(result.error, 'KUGOU_URL_UNAVAILABLE');
  assert.strictEqual(result.reason, 'paid_required');
  assert.ok(!/Unexpected token|HTTP/i.test(result.message || ''), 'Playback failure should not expose raw HTTP/JSON parser errors');
}

async function testPaidSongUrlCarriesVipLoginStateAndToken() {
  const requests = [];
  const cookieFile = path.join(__dirname, '.tmp-kugou-vip-playback-cookie');
  require('fs').writeFileSync(cookieFile, 'userid=42; token=login-token; vip_token=vip-token; vip_type=1; viplevel=1; dfid=dfid-1; mid=mid-1');
  const kugou = createKugouProvider({
    requestText: async (url) => {
      requests.push(new URL(url));
      if (url.includes('m3ws.kugou.com/v1/song/info')) return JSON.stringify({ status: 0, error_msg: 'unavailable' });
      if (url.includes('wwwapi.kugou.com/play/index')) {
        return JSON.stringify({ data: { url: [] } });
      }
      if (url.includes('trackercdn.kugou.com')) {
        return JSON.stringify({ status: 0, error: 'Bad key' });
      }
      if (url.includes('m.kugou.com/app/i/getSongInfo.php')) {
        return JSON.stringify({ status: 0, errcode: 0, error: '需要付费', url: '', pay_type: 3, privilege: 10 });
      }
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: (provider, category, message, action, extra) => ({ provider, category, message, action, extra }),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile,
  });
  const result = await kugou.handleSongUrl('ABCDEF123456', '456', 'hires');
  const playIndex = requests.find(u => u.hostname === 'wwwapi.kugou.com');
  const mobileInfo = requests.find(u => u.hostname === 'm.kugou.com');
  assert.strictEqual(mobileInfo.searchParams.get('userid'), '42');
  assert.strictEqual(mobileInfo.searchParams.get('token'), 'login-token');
  assert.strictEqual(mobileInfo.searchParams.get('vip_token'), 'vip-token');
  assert.strictEqual(result.loggedIn, true);
  assert.strictEqual(result.isVip, true);
  assert.strictEqual(result.vipLevel, 'vip');
  assert.ok(/VIP|会员|购买/.test(result.message || ''));
}

async function testLoginInfoRefreshesVipTokenFromAndroidSession() {
  const cookieFile = path.join(__dirname, '.tmp-kugou-vip-refresh-cookie');
  require('fs').writeFileSync(cookieFile, 'userid=42; token=login-token; dfid=dfid-1; mid=mid-1');
  const kugou = createKugouProvider({
    requestText: async (url) => {
      if (url.includes('/v5/login_by_token')) {
        return JSON.stringify({ status: 1, data: { userid: 42, token: 'fresh-token', vip_type: 1, vip_token: 'fresh-vip-token' } });
      }
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: (provider, category, message, action, extra) => ({ provider, category, message, action, extra }),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile,
  });
  const info = await kugou.getLoginInfo();
  assert.strictEqual(info.loggedIn, true);
  assert.strictEqual(info.isVip, true);
  assert.strictEqual(info.vipLevel, 'vip');
  const saved = require('fs').readFileSync(cookieFile, 'utf8');
  assert.ok(saved.includes('vip_token=fresh-vip-token'));
}

async function testVipWithoutVipTokenRequiresReloginForPaidSongs() {
  const cookieFile = path.join(__dirname, '.tmp-kugou-vip-missing-token-cookie');
  require('fs').writeFileSync(cookieFile, 'userid=42; token=login-token; vip_type=1; dfid=dfid-1; mid=mid-1');
  const kugou = createKugouProvider({
    requestText: async (url) => {
      if (url.includes('m3ws.kugou.com/v1/song/info')) return JSON.stringify({ status: 0, err_code: 30001, error_msg: 'failed' });
      if (url.includes('wwwapi.kugou.com/play/index')) return JSON.stringify({ data: { url: [] } });
      if (url.includes('trackercdn.kugou.com')) return JSON.stringify({ status: 0, error: 'Bad key' });
      if (url.includes('m.kugou.com/app/i/getSongInfo.php')) return JSON.stringify({ status: 0, errcode: 0, error: '需要付费', url: '', pay_type: 3, privilege: 10 });
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: (provider, category, message, action, extra) => ({ provider, category, message, action, extra }),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile,
  });
  const result = await kugou.handleSongUrl('ABCDEF123456', '456', 'hires');
  assert.strictEqual(result.isVip, true);
  assert.strictEqual(result.hasVipToken, false);
  // 移动接口权威返回"需要付费/pay_type/privilege"时应判为会员权限未同步（需重新登录），
  // 而非被 m3ws 的 30001 噪音误判成签名/授权问题。
  assert.strictEqual(result.reason, 'vip_token_required');
  assert.ok(/会员|登录|授权/.test(result.message || ''));
}

async function testSongUrlUsesM3wsAndAlbumAudioId() {
  const requests = [];
  const kugou = createKugouProvider({
    requestText: async (url) => {
      requests.push(new URL(url));
      if (url.includes('m3ws.kugou.com/v1/song/info')) {
        return JSON.stringify({ data: { play_url: 'https://audio.example/vip.flac', bitRate: 320, extName: 'flac' } });
      }
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: () => ({}),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile: path.join(__dirname, '.tmp-kugou-m3ws-test-cookie'),
  });
  const result = await kugou.handleSongUrl('ABCDEF123456', '456', 'hires', '123');
  const m3ws = requests[0];
  assert.strictEqual(result.playable, true);
  assert.strictEqual(result.url, 'https://audio.example/vip.flac');
  assert.strictEqual(m3ws.hostname, 'm3ws.kugou.com');
  assert.strictEqual(m3ws.searchParams.get('album_id'), '456');
  assert.strictEqual(m3ws.searchParams.get('album_audio_id'), '123');
  assert.ok(m3ws.searchParams.get('signature'));
}

async function testBadKeyIsReportedAsAuthorizationNotCopyright() {
  const kugou = createKugouProvider({
    requestText: async (url) => {
      if (url.includes('m3ws.kugou.com/v1/song/info')) return JSON.stringify({ status: 0, err_code: 30001, error_msg: 'failed' });
      if (url.includes('wwwapi.kugou.com/play/index')) return JSON.stringify({ status: 0, error: 'Bad key' });
      if (url.includes('trackercdn.kugou.com')) return JSON.stringify({ status: 0, error: 'Bad key' });
      if (url.includes('m.kugou.com/app/i/getSongInfo.php')) return JSON.stringify({ status: 0, errcode: 0, error: '', url: '' });
      throw new Error('Unexpected request: ' + url);
    },
    UA: 'MineradioTest/1.0',
    normalizeQualityPreference: value => value || 'hires',
    playbackRestriction: (provider, category, message, action, extra) => ({ provider, category, message, action, extra }),
    decodeQQLyricText: value => value,
    decodeHtmlEntities: value => value,
    cookieFile: path.join(__dirname, '.tmp-kugou-badkey-test-cookie'),
  });
  const result = await kugou.handleSongUrl('ABCDEF123456', '456', 'hires', '123');
  assert.strictEqual(result.playable, false);
  assert.strictEqual(result.reason, 'signature_or_authorization_unavailable');
  assert.ok(/授权|接口/.test(result.message || ''));
}

testSearchFallsBackWhenComplexSearchSignatureFails()
  .then(testPaidSongUrlIsUnavailableNotHttpFailure)
  .then(testPaidSongUrlCarriesVipLoginStateAndToken)
  .then(testLoginInfoRefreshesVipTokenFromAndroidSession)
  .then(testVipWithoutVipTokenRequiresReloginForPaidSongs)
  .then(testSongUrlUsesM3wsAndAlbumAudioId)
  .then(testBadKeyIsReportedAsAuthorizationNotCopyright)
  .then(() => console.log('ok'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
