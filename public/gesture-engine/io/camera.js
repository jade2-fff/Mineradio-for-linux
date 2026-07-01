'use strict';
/**
 * gesture-engine / io/camera.js
 * ============================================================================
 * 相机后端 (对应 Dart_Vision io/).
 * getUserMedia + MediaPipe Hands 加载 / 帧调度.
 * 暴露 CameraBackend: { start(onResults), stop(), isRunning() }.
 *
 * 不画视频 / 不画骨架 (去掉投影). 仅把 21 个 landmark 喂给上层.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var cfg = (window.MineradioGestureCfg || {}).cfg || {};
  var camCfg = cfg.camera || {};
  var log = window.log || { info: function(){}, warn: function(){}, error: function(){} };

  // 去重加载外部脚本 (从主页面 loadScriptOnce 风格移植, 引擎自带副本避免依赖主页面)
  var _loaded = {};
  function loadScriptOnce(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise(function (resolve, reject) {
      var hit = document.querySelector('script[src="' + url + '"]');
      if (hit) { resolve(); return; }
      var sc = document.createElement('script');
      sc.src = url; sc.async = true;
      sc.onload = function () { resolve(); };
      sc.onerror = function () { reject(new Error('script load fail: ' + url)); };
      document.head.appendChild(sc);
    });
    return _loaded[url];
  }

  function isLinuxRuntime() {
    return /Linux/i.test(navigator.userAgent || '') || /X11/i.test(navigator.userAgent || '');
  }

  function cameraSize() {
    if (isLinuxRuntime() && camCfg.linuxLowPower) {
      return { width: camCfg.linuxWidth || 480, height: camCfg.linuxHeight || 360 };
    }
    return { width: camCfg.width || 640, height: camCfg.height || 480 };
  }

  function modelComplexity() {
    if (isLinuxRuntime() && camCfg.linuxLowPower) return 0;
    return camCfg.modelComplexity != null ? camCfg.modelComplexity : 1;
  }

  function friendlyCameraError(e) {
    var name = (e && (e.name || e.code)) || '';
    var msg = (e && e.message) || String(e || '');
    if (/NotAllowedError|PermissionDenied/i.test(name + msg)) return '摄像头权限被拒绝';
    if (/NotFoundError|DevicesNotFound/i.test(name + msg)) return '没有找到摄像头设备';
    if (/NotReadableError|TrackStartError|Could not start video source/i.test(name + msg)) return '摄像头被其它程序占用';
    if (/script load fail/i.test(msg)) return 'MediaPipe 加载失败, 请检查网络';
    return msg || '摄像头启动失败';
  }

  // CameraBackend
  var CameraBackend = {
    _video: null,
    _hands: null,
    _camera: null,
    _running: false,
    _onResults: null,
    _ready: false,

    /**
     * @param {function(landmarks|null)} onResults  每帧回调, 传 null 表示无手
     */
    start: function (onResults) {
      var self = this;
      if (self._running) return Promise.resolve();
      self._onResults = onResults;
      log.info('IO', '加载 MediaPipe Hands...');
      return Promise.resolve()
        .then(function () { return loadScriptOnce(camCfg.cameraUtilsUrl); })
        .then(function () { return loadScriptOnce(camCfg.handsUrl); })
        .then(function () {
          self._video = document.createElement('video');
          self._video.playsInline = true;
          self._video.muted = true;
          self._video.style.display = 'none';
          document.body.appendChild(self._video);

          // eslint-disable-next-line no-undef
          self._hands = new Hands({ locateFile: function (f) { return camCfg.handsLocateBase + f; } });
          self._hands.setOptions({
            maxNumHands: camCfg.maxNumHands || 1,
            modelComplexity: modelComplexity(),
            minDetectionConfidence: camCfg.minDetectionConfidence || 0.65,
            minTrackingConfidence: camCfg.minTrackingConfidence || 0.60
          });
          self._hands.onResults(function (res) {
            if (!self._running) return;
            var lm = res.multiHandLandmarks && res.multiHandLandmarks[0];
            if (self._onResults) self._onResults(lm || null);
          });

          // eslint-disable-next-line no-undef
          var size = cameraSize();
          self._camera = new Camera(self._video, {
            onFrame: function () {
              if (self._hands) return self._hands.send({ image: self._video });
              return Promise.resolve();
            },
            width: size.width,
            height: size.height
          });
          return self._camera.start();
        })
        .then(function () {
          self._running = true;
          self._ready = true;
          var size = cameraSize();
          log.info('IO', 'MediaPipe 相机已就绪 ' + size.width + 'x' + size.height + ' model=' + modelComplexity());
        })
        .catch(function (e) {
          var friendly = friendlyCameraError(e);
          log.error('IO', '启动失败:', friendly, e && e.message || e);
          self._cleanup();
          var wrapped = new Error(friendly);
          wrapped.cause = e;
          throw wrapped;
        });
    },

    stop: function () {
      if (!this._running) return;
      try { if (this._camera && this._camera.stop) this._camera.stop(); } catch (e) {}
      try {
        if (this._video && this._video.srcObject) this._video.srcObject.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
      this._cleanup();
      log.info('IO', '已停止');
    },

    isRunning: function () { return !!this._running; },

    _cleanup: function () {
      try { if (this._video) this._video.remove(); } catch (e) {}
      this._video = null;
      this._hands = null;
      this._camera = null;
      this._running = false;
      this._onResults = null;
    }
  };

  GE.CameraBackend = CameraBackend;
})(window);