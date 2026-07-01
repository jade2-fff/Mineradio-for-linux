// ====================================================================
//  酷狗音乐前端源适配
//   - 不依赖模块打包器，挂到 window.MineradioKugouSource
//   - 只负责酷狗 API URL 拼接、字段判定和平台元信息，避免再把源逻辑塞回 index.html
// ====================================================================
(function(){
  'use strict';

  function enc(value) { return encodeURIComponent(value == null ? '' : String(value)); }

  function isKugouSong(song) {
    return !!(song && (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou'));
  }

  function songId(song) {
    song = song || {};
    return song.hash || song.songHash || song.id || '';
  }

  function songKey(song) {
    song = song || {};
    return 'kugou:' + (songId(song) || ((song.name || '') + '|' + (song.artist || '')));
  }

  function playlistId(raw) {
    var text = String(raw || '');
    return text.indexOf('kugou:') === 0 ? text.slice(6) : '';
  }

  function playlistPrefixedId(id) {
    return 'kugou:' + id;
  }

  function searchUrl(query, limit) {
    return '/api/kugou/search?keywords=' + enc(query) + '&limit=' + enc(limit || 12);
  }

  function songUrl(song, qualityParam) {
    song = song || {};
    return '/api/kugou/song/url?hash=' + enc(songId(song)) +
      '&albumId=' + enc(song.albumId || song.album_id || '') +
      (qualityParam || '');
  }

  function lyricUrl(song) {
    return '/api/kugou/lyric?hash=' + enc(songId(song));
  }

  function commentsUrl(song, limit) {
    return '/api/kugou/song/comments?hash=' + enc(songId(song)) + '&limit=' + enc(limit || 18);
  }

  function artistId(song) {
    if (!isKugouSong(song)) return '';
    if (song.artistId) return String(song.artistId);
    if (song.artistMid) return String(song.artistMid);
    var artists = song.artists || [];
    for (var i = 0; i < artists.length; i++) {
      if (artists[i] && (artists[i].id || artists[i].mid)) return String(artists[i].id || artists[i].mid);
    }
    return '';
  }

  function artistDetailUrl(song, limit) {
    var id = artistId(song);
    return id ? ('/api/kugou/artist/detail?mid=' + enc(id) + '&limit=' + enc(limit || 36)) : '';
  }

  function playlistTracksUrl(id) {
    return '/api/kugou/playlist/tracks?id=' + enc(id);
  }

  function loginStatusUrl() { return '/api/kugou/login/status?t=' + Date.now(); }
  function loginCookieUrl() { return '/api/kugou/login/cookie'; }
  function logoutUrl() { return '/api/kugou/logout'; }
  function userPlaylistsUrl() { return '/api/kugou/user/playlists'; }

  window.MineradioKugouSource = {
    key: 'kugou',
    short: 'KG',
    label: '酷狗音乐',
    app: '酷狗音乐 App',
    dot: 'kugou',
    isSong: isKugouSong,
    songId: songId,
    songKey: songKey,
    playlistId: playlistId,
    playlistPrefixedId: playlistPrefixedId,
    searchUrl: searchUrl,
    songUrl: songUrl,
    lyricUrl: lyricUrl,
    commentsUrl: commentsUrl,
    artistId: artistId,
    artistDetailUrl: artistDetailUrl,
    playlistTracksUrl: playlistTracksUrl,
    loginStatusUrl: loginStatusUrl,
    loginCookieUrl: loginCookieUrl,
    logoutUrl: logoutUrl,
    userPlaylistsUrl: userPlaylistsUrl
  };
})();
