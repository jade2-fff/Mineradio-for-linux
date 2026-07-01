'use strict';
/**
 * gesture-engine / index.js
 * ============================================================================
 * 引擎门面 (对应 Dart_Vision main.cpp).
 *
 * 主页面只调用 MineradioGesture 的 4 个方法:
 *   start()         启动相机 + 识别 (替代 startGestureControl)
 *   stop()          停止 (替代 stopGestureControl)
 *   tick(dt)        每帧调用, 处理状态机 + 命令派发 + 衰减 (替代 tickGestureRotation)
 *   bind(handlers)  注入命令回调 (togglePlay/nextTrack/...)
 *   hud(label,progress,detail)  可选 HUD 提示回调注入
 *
 * 加载顺序: 由 index.html 在 vendor 之后 script 标签顺序加载
 *   config -> logger -> vision/* -> control/* -> index (本文件)
 * 全部挂到 window.MineradioGesture 命名空间, 避免污染主页全局.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});

  var Cam = GE.CameraBackend;
  var Detect = GE.HandDetector;
  var SM = GE.StateMachine;
  var Aimer = GE.Aimer;
  var Cmd = GE.Commands;
  var Frame = GE.GestureFrame;
  var log = window.log || { info: function(){}, warn: function(){}, error: function(){} };

  // 复用的 GestureFrame 实例 (避免每帧分配)
  var _frame = null;
  // 主循环 dt 累积 (相机按自身帧率回调, 我们主循环只跑状态超时 + 命令派发)
  var _active = false;
  var _prevState = SM.ST ? SM.ST.IDLE : 0;
  var _hudCb = null;       // hud(label, progress, detail) 可选
  var _toastCb = null;     // showToast(msg) 可选

  // 命令派发回调集 (主页面通过 bind 注入)
  function bind(handlers) {
    if (Cmd && Cmd.bind) Cmd.bind(handlers || {});
    if (handlers && typeof handlers.onHud === 'function') _hudCb = handlers.onHud;
    if (handlers && typeof handlers.onToast === 'function') _toastCb = handlers.onToast;
  }

  function _ensureFrame() {
    if (!_frame) _frame = Frame ? Frame() : { hasHand: false, palm: {x:0,y:0}, pushPt:{x:0,y:0}, openness:0, curl:0, speed:0, timestamp:0, lm:null };
    return _frame;
  }

  function start() {
    if (_active) return Promise.resolve();
    _active = true;
    _prevState = SM.ST.IDLE;
    if (SM.reset) SM.reset();
    if (Detect.reset) Detect.reset();
    if (Aimer && Aimer.reset) Aimer.reset();
    _ensureFrame();
    if (_toastCb) _toastCb('正在加载手势识别…');
    log.info('Engine', '启动');
    return Cam.start(function (rawLm) {
      // 每帧识别回调: 平滑 + 抽特征 -> 状态机
      var f = Detect.detect(rawLm, _frame);
      var prevState = SM.getState();
      SM.tick(f);
      var curSt = SM.getState();
      // 状态切换 -> aimer 决策
      if (curSt !== prevState || curSt === SM.ST.PINCH || curSt === SM.ST.HOVER) {
        var cmds = Aimer.decide(f, prevState);
        if (cmds && cmds.length) {
          for (var i = 0; i < cmds.length; i++) Cmd.dispatch(cmds[i]);
        }
      }
      _prevState = curSt;
      // HUD
      if (_hudCb) {
        var label = SM.getStateName();
        var prog = 0, detail = '';
        if (curSt === SM.ST.PINCH) { prog = 1; detail = '左/右挥 = 切歌 · 松开 = 播放/暂停'; }
        else if (curSt === SM.ST.FIST) { prog = 0.7; detail = '聚焦歌单架'; }
        else if (curSt === SM.ST.HOVER && f.openness > 0.62) { prog = 0.4; detail = '横向移动 = 旋转歌单架'; }
        else { prog = 0; detail = '五指收拢 = 切歌 · 握拳 = 聚焦'; }
        _hudCb(label, prog, detail);
      }
    }).then(function () {
      if (_toastCb) _toastCb('手势已开启: 五指收拢切歌 · 握拳聚焦');
      if (_hudCb) _hudCb('待命', 0, '把手放进视野');
    }).catch(function (e) {
      _active = false;
      if (_toastCb) _toastCb('手势启动失败 (需要摄像头权限)');
      log.error('Engine', 'start 失败', e && e.message || e);
      throw e;
    });
  }

  function stop() {
    if (!_active) return;
    _active = false;
    try { Cam.stop(); } catch (e) {}
    if (SM.reset) SM.reset();
    if (Detect.reset) Detect.reset();
    if (Aimer && Aimer.reset) Aimer.reset();
    _prevState = SM.ST.IDLE;
    if (_hudCb) _hudCb('', 0, '');
    log.info('Engine', '停止');
  }

  // 主循环每帧调用 - 仅做无手超时兜底 (相机回调里已完成状态机 tick)
  function tick(dt) {
    if (!_active) return;
    var now = performance.now();
    var cfg = (window.MineradioGestureCfg || {}).cfg || {};
    var timeout = (cfg.state || {}).idleTimeoutMs || 600;
    if (SM.getIdleSince && SM.getIdleSince(now) > timeout) {
      if (_frame && !_frame.hasHand && SM.getState && SM.getState() !== SM.ST.IDLE) {
        SM.reset && SM.reset();
        Aimer && Aimer.reset && Aimer.reset();
        if (_hudCb) _hudCb('待命', 0, '把手放进视野');
      }
    }
  }

  function isActive() { return _active; }

  GE.start = start;
  GE.stop = stop;
  GE.tick = tick;
  GE.bind = bind;
  GE.isActive = isActive;

  log.info('Engine', '已就绪 (gesture-engine v9.3)');
})(window);