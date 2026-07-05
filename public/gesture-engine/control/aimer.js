'use strict';
/**
 * gesture-engine / control/aimer.js
 * ============================================================================
 * 决策器 (对应 Dart_Vision control::DartAimer).
 * 把状态机当前状态 + 手掌位移映射为 Command.
 *
 * v9.4 五指收拢驱动:
 *   PINCH (五指聚拢) + 上/下快速挥动 -> NEXT/PREV
 *   PINCH -> RELEASE 一次 (收拢-张开完整周期) -> PLAY_PAUSE
 *   FIST -> SHELF_FOCUS
 *   HOVER + 五指张开 + 横向移动 -> SHELF_ROTATE
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var c = (window.MineradioGestureCfg || {}).cfg || {};
  var A = c.aimer || {};
  var SM = (GE.StateMachine || {});
  var Cmd = (GE.Commands || {});
  var log = window.log || { debug: function(){}, info: function(){} };

  var ST = SM.ST || { IDLE: 0, HOVER: 1, PINCH: 2, FIST: 3, RELEASE: 4, OPEN_RELEASE: 5 };

  // 上/下挥动累积 (在 PINCH 期间)
  var _lastPalmY = 0;
  var _pinchHasRef = false;
  // 冷却时间戳
  var _lastSwipeTs = 0;
  var _lastPlayPauseTs = 0;
  var _lastShelfRotateTs = 0;
  var _playPauseTempPinchFlag = false;
  // SHELF_ROTATE 跟踪
  var _hoverRotateBaseX = 0;
  var _hoverRotateHasRef = false;

  function reset() {
    _lastPalmY = 0;
    _pinchHasRef = false;
    _lastSwipeTs = 0;
    _lastPlayPauseTs = 0;
    _lastShelfRotateTs = 0;
    _playPauseTempPinchFlag = false;
    _hoverRotateBaseX = 0;
    _hoverRotateHasRef = false;
  }

  /**
   * @param frame     GestureFrame
   * @param prevState 上一帧状态 (用于检测状态转换)
   * @return {Array<Command>} 本帧要派发的命令列表 (可能为空)
   */
  function decide(frame, prevState) {
    var cmds = [];
    var st = SM.getState();
    var now = frame.timestamp;
    var palmY = frame.palm.y;
    var palmX = frame.palm.x;

    // ---- 进入 PINCH 时记录起点 (用于切歌挥动判定) ----
    if (prevState !== ST.PINCH && st === ST.PINCH) {
      _lastPalmY = palmY;
      _pinchHasRef = true;
      _playPauseTempPinchFlag = true;
      log.debug('Aimer', 'PINCH 入, 起点 y=' + palmY.toFixed(3));
    }

    // ---- PINCH 期间上/下挥动 -> 切歌 ----
    if (st === ST.PINCH && _pinchHasRef) {
      var dy = palmY - _lastPalmY;
      var swipeMin = A.swipeYMin || 0.09;
      var speedMin = A.swipeSpeedMin || 0.010;
      var cooldown = A.swipeCooldownMs || 620;
      // 关键: 只要出现明显竖向挥动意图(过半阈值)就取消 PLAY_PAUSE 判定,
      // 避免挥手切歌途中手指自然松开被误当成 收拢→张开 的播放/暂停手势。
      if (Math.abs(dy) > swipeMin * 0.5) _playPauseTempPinchFlag = false;
      if (Math.abs(dy) > swipeMin && frame.speed >= speedMin && (now - _lastSwipeTs) > cooldown) {
        cmds.push({ type: dy < 0 ? Cmd.Type.NEXT_TRACK : Cmd.Type.PREV_TRACK, dy: dy, speed: frame.speed, ts: now });
        _lastSwipeTs = now;
        _playPauseTempPinchFlag = false;
        _lastPalmY = palmY;
        log.info('Aimer', (dy < 0 ? 'NEXT' : 'PREV') + ' dy=' + dy.toFixed(3) + ' v=' + frame.speed.toFixed(3));
      }
    }

    // ---- PINCH -> RELEASE 完整周期 -> PLAY_PAUSE (冷却防连发) ----
    if (prevState === ST.PINCH && st === ST.RELEASE) {
      var ppCooldown = A.playPauseCooldownMs || 900;
      if (_playPauseTempPinchFlag && (now - _lastPlayPauseTs) > ppCooldown) {
        cmds.push({ type: Cmd.Type.PLAY_PAUSE, ts: now });
        _lastPlayPauseTs = now;
        log.info('Aimer', 'PLAY_PAUSE');
      }
      _playPauseTempPinchFlag = false;
      _pinchHasRef = false;
    }

    // ---- FIST -> SHELF_FOCUS (锁定/聚焦歌单架) ----
    if (prevState !== ST.FIST && st === ST.FIST) {
      cmds.push({ type: Cmd.Type.SHELF_FOCUS, ts: now });
      log.info('Aimer', 'SHELF_FOCUS');
    }

    // ---- HOVER + 张开 + 横向移动 -> SHELF_ROTATE ----
    if (st === ST.HOVER && frame.openness > (A.shelfRotateOpennessMin || 0.62)
        && frame.curl < (A.shelfRotateCurlMax || 0.35)) {
      if (!_hoverRotateHasRef) { _hoverRotateBaseX = palmX; _hoverRotateHasRef = true; }
      else {
        var rdx = palmX - _hoverRotateBaseX;
        var rMin = A.shelfRotateSwipeX || 0.10;
        var rCd = A.shelfRotateCooldownMs || 320;
        if (Math.abs(rdx) > rMin && (now - _lastShelfRotateTs) > rCd) {
          cmds.push({ type: Cmd.Type.SHELF_ROTATE, dir: rdx > 0 ? 1 : -1, dx: rdx, ts: now });
          _lastShelfRotateTs = now;
          _hoverRotateBaseX = palmX;
          log.debug('Aimer', 'SHELF_ROTATE dir=' + (rdx > 0 ? +1 : -1));
        }
      }
    } else {
      _hoverRotateHasRef = false;
    }

    return cmds;
  }

  GE.Aimer = { decide: decide, reset: reset };
})(window);