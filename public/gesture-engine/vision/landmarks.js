'use strict';
/**
 * gesture-engine / vision/landmarks.js
 * ============================================================================
 * landmark 平滑层 (对应 Dart_Vision vision/detector 预处理).
 *
 * v9.1 算法原样保留:
 *   - 镜像 X (摄像头反像)
 *   - 3 帧加权中值预滤波 (借鉴 dj-analyzer bandAt 三点加权)
 *   - 双 EMA (fast + slow) 输出混合 70/30
 *   - 速度自适应 EMA 系数 (高速时加大 α 跟手, 静止时缩小 α 稳定)
 *   - 高速时 bypass 中值 (避免延迟卡顿)
 *   - per-landmark 速度 + 全掌速度计算
 *
 * 预分配缓冲复用, 消除每帧 GC 压力.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var c = (window.MineradioGestureCfg || {}).cfg || {};
  var L = c.landmarks || {};
  var F = c.features || {};
  var log = window.log || { debug: function(){}, warn: function(){} };

  // 预分配 3 × 21 个 {x,y,z} 复用对象
  var _handBuf = [];
  (function () { for (var i = 0; i < 3; i++) { var a = []; for (var j = 0; j < 21; j++) a.push({ x: 0, y: 0, z: 0 }); _handBuf.push(a); } })();
  var _handBufFilled = [false, false, false];
  var _handPrevRaw = null;
  (function () { var a = []; for (var j = 0; j < 21; j++) a.push({ x: 0, y: 0, z: 0 }); _handPrevRaw = a; })();
  var _handPrevRawHas = false;
  var handSpeed = 0;     // 平滑后的全掌速度 (归一化)
  var handSpeedRaw = 0;  // 原始瞬时速度

  var SPEED_IDX = F.handSpeedIdx || [0, 4, 8, 12, 16, 20];

  function reset() {
    _handBufFilled = [false, false, false];
    _handPrevRawHas = false;
    handSpeed = 0;
    handSpeedRaw = 0;
  }

  function weightedMedian3(a, b, c) { return a * 0.25 + b * 0.50 + c * 0.25; }

  function computeHandSpeed(rawLm) {
    if (!_handPrevRawHas) return 0;
    var s = 0, n = SPEED_IDX.length;
    for (var k = 0; k < n; k++) {
      var i = SPEED_IDX[k];
      var dx = rawLm[i].x - _handPrevRaw[i].x;
      var dy = rawLm[i].y - _handPrevRaw[i].y;
      s += Math.sqrt(dx * dx + dy * dy);
    }
    return s / n;
  }

  /**
   * 平滑单个 landmark 索引的镜像帧.
   * @param  {Array<{x,y,z}=21>} rawLm  raw MediaPipe landmarks
   * @param  {Array<{x,y,z}=21>} handLmSmooth  上一帧 smoothing buffer (会被原地更新)
   * @return {Array<{x,y,z}=21>} smoothed landmarks (=== handLmSmooth)
   */
  function smooth(rawLm, handLmSmooth) {
    // v9.1 先算全掌速度
    var v = computeHandSpeed(rawLm);
    handSpeedRaw = v;
    handSpeed = handSpeed * (1 - (F.handSpeedEma || 0.22)) + v * (F.handSpeedEma || 0.22);

    // 1. 镜像 X -> 写入 _handBuf[0] (复用预分配)
    var cur = _handBuf[0];
    for (var i = 0; i < 21; i++) {
      cur[i].x = 1 - rawLm[i].x;
      cur[i].y = rawLm[i].y;
      cur[i].z = rawLm[i].z || 0;
    }
    // 缓存上一帧原始 landmark
    for (var i = 0; i < 21; i++) {
      _handPrevRaw[i].x = rawLm[i].x;
      _handPrevRaw[i].y = rawLm[i].y;
      _handPrevRaw[i].z = rawLm[i].z || 0;
    }
    _handPrevRawHas = true;

    // 2. 推入环形帧缓冲
    // (用模块内手维护的 idx, 不污染全局)
    if (!smooth._bufIdx) smooth._bufIdx = 0;
    smooth._bufIdx = (smooth._bufIdx + 1) % 3;
    var slot = _handBuf[smooth._bufIdx];
    for (var i = 0; i < 21; i++) {
      slot[i].x = cur[i].x; slot[i].y = cur[i].y; slot[i].z = cur[i].z;
    }
    _handBufFilled[smooth._bufIdx] = true;

    // 3. 高速时 bypass 3 帧中值
    var vFast = L.handVFaster || 0.026;
    var doMedian = handSpeed < vFast;
    var filtered = cur;
    if (doMedian && _handBufFilled[0] && _handBufFilled[1] && _handBufFilled[2]) {
      filtered = _handBuf[2];
      for (var i = 0; i < 21; i++) {
        filtered[i].x = weightedMedian3(_handBuf[0][i].x, _handBuf[1][i].x, _handBuf[2][i].x);
        filtered[i].y = weightedMedian3(_handBuf[0][i].y, _handBuf[1][i].y, _handBuf[2][i].y);
        filtered[i].z = weightedMedian3(_handBuf[0][i].z, _handBuf[1][i].z, _handBuf[2][i].z);
      }
    }

    // 4. 双 EMA - 系数按速度动态放大
    if (!handLmSmooth) {
      handLmSmooth = [];
      for (var i = 0; i < 21; i++) handLmSmooth.push({ x: filtered[i].x, y: filtered[i].y, z: filtered[i].z });
      return handLmSmooth;
    }
    var vIdle = L.handVIdle || 0.0045;
    var t = (handSpeed - vIdle) / (vFast - vIdle);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var af = (L.handEmaIdleFast || 0.45) + ((L.handEmaFastFast || 0.78) - (L.handEmaIdleFast || 0.45)) * t;
    var as_ = (L.handEmaIdleSlow || 0.18) + ((L.handEmaFastSlow || 0.42) - (L.handEmaIdleSlow || 0.18)) * t;
    if (handSpeed > vFast * (L.handVIgnBias || 2.5)) { af = 0.96; as_ = 0.92; }
    for (var i = 0; i < 21; i++) {
      var fx = handLmSmooth[i].x + (filtered[i].x - handLmSmooth[i].x) * af;
      var fy = handLmSmooth[i].y + (filtered[i].y - handLmSmooth[i].y) * af;
      var fz = handLmSmooth[i].z + (filtered[i].z - handLmSmooth[i].z) * af;
      var sx = handLmSmooth[i].x + (filtered[i].x - handLmSmooth[i].x) * as_;
      var sy = handLmSmooth[i].y + (filtered[i].y - handLmSmooth[i].y) * as_;
      var s_z = handLmSmooth[i].z + (filtered[i].z - handLmSmooth[i].z) * as_;
      handLmSmooth[i].x = fx * 0.70 + sx * 0.30;
      handLmSmooth[i].y = fy * 0.70 + sy * 0.30;
      handLmSmooth[i].z = fz * 0.70 + s_z * 0.30;
    }
    return handLmSmooth;
  }

  GE.Landmarks = { smooth: smooth, reset: reset, getSpeed: function () { return handSpeed; }, getSpeedRaw: function () { return handSpeedRaw; } };
})(window);