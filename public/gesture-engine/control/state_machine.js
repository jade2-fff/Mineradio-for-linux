'use strict';
/**
 * gesture-engine / control/state_machine.js
 * ============================================================================
 * 有限状态机 (对应 Dart_Vision control 里决策子模块 + DartConfirmer 抗误检).
 *
 * 6 态: IDLE / HOVER / PINCH / FIST / RELEASE / OPEN_RELEASE
 * v9.3 五指收拢 (curl) 主驱动 + hysteresis 迟滞, 防单帧抖动反复触发.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var c = (window.MineradioGestureCfg || {}).cfg || {};
  var S = c.state || {};
  var log = window.log || { debug: function(){}, info: function(){} };

  var ST = {
    IDLE: 0, HOVER: 1, PINCH: 2, FIST: 3, RELEASE: 4, OPEN_RELEASE: 5
  };
  // 字符串映射, 便于日志与上层 HUD
  var ST_NAME = ['IDLE', 'HOVER', 'PINCH', 'FIST', 'RELEASE', 'OPEN_RELEASE'];

  var _st = ST.IDLE;
  var _holdCount = 0;
  var _lastSeenTs = 0;

  function reset() {
    _st = ST.IDLE;
    _holdCount = 0;
    _lastSeenTs = 0;
  }

  function transition(newState) {
    if (newState === _st) return;
    log.debug('State', ST_NAME[_st] + ' -> ' + ST_NAME[newState]);
    _st = newState;
    _holdCount = 0;
  }

  /**
   * 每帧喂入特征. hasHand=false 时 timestamp 也会更新 (用于超时回 IDLE).
   * @param frame GestureFrame
   */
  function tick(frame) {
    var now = frame.timestamp;
    _lastSeenTs = now;
    // 无手 -> 直接释放, 由上层 idleTimeout 定后再 reset
    if (!frame.hasHand) {
      // 等到 idleTimeout 之后才回 IDLE (给短暂遮挡一点缓冲, 但释放 FIST/PINCH 立即)
      if (_st === ST.PINCH) transition(ST.RELEASE);
      else if (_st === ST.FIST) transition(ST.OPEN_RELEASE);
      return;
    }

    var idleTimeout = S.idleTimeoutMs || 600;
    // 无手超时回 IDLE (由上层 tick 定时调用时 frame.hasHand=false 的累积来判断)
    // 这里只做有手时的状态判定
    _holdCount++;

    var curl = frame.curl;
    var openness = frame.openness;
    var pinchCurlOn = S.pinchCurlOn != null ? S.pinchCurlOn : 0.62;
    var pinchCurlOff = S.pinchCurlOff != null ? S.pinchCurlOff : 0.42;
    var fistCurlOn = S.fistCurlOn != null ? S.fistCurlOn : 0.85;
    var fistCurlOff = S.fistCurlOff != null ? S.fistCurlOff : 0.65;

    switch (_st) {
      case ST.IDLE:
        if (_holdCount >= 3 && curl > 0.05) transition(ST.HOVER);
        break;
      case ST.HOVER:
        if (_holdCount >= 3 && curl > pinchCurlOn) transition(ST.PINCH);
        else if (_holdCount >= 4 && curl > fistCurlOn && openness < 0.28) transition(ST.FIST);
        break;
      case ST.PINCH:
        if (_holdCount >= 2 && curl < pinchCurlOff) transition(ST.RELEASE);
        break;
      case ST.RELEASE:
        if (curl > pinchCurlOn) transition(ST.PINCH);
        else if (_holdCount > 12) transition(ST.IDLE);
        break;
      case ST.FIST:
        if (_holdCount >= 2 && curl < fistCurlOff) transition(ST.OPEN_RELEASE);
        break;
      case ST.OPEN_RELEASE:
        if (curl > fistCurlOn) transition(ST.FIST);
        else if (curl > pinchCurlOn) transition(ST.PINCH);
        else if (_holdCount > 10) transition(ST.IDLE);
        break;
    }
  }

  function getState() { return _st; }
  function getStateName() { return ST_NAME[_st]; }
  function getIdleSince(now) {
    // 上层用此判断是否超出 idleTimeout -> 强制 reset
    return _lastSeenTs === 0 ? 0 : (now - _lastSeenTs);
  }

  GE.GestureState = ST;
  GE.StateMachine = {
    ST: ST,
    ST_NAME: ST_NAME,
    tick: tick,
    reset: reset,
    transition: transition,
    getState: getState,
    getStateName: getStateName,
    getIdleSince: getIdleSince,
    _setLastSeen: function (ts) { _lastSeenTs = ts; }
  };
})(window);