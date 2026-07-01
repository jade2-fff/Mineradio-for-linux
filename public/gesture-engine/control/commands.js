'use strict';
/**
 * gesture-engine / control/commands.js
 * ============================================================================
 * Command 枚举 + 派发器 (对应 Dart_Vision control -> io 协议层).
 *
 * 引擎不直接耦合主页面内部函数, 通过 bind 注入的回调派发命令.
 * 派发器负责: 去重 / 冷却 / 命令格式校验.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var log = window.log || { info: function(){}, warn: function(){} };

  var Type = Object.freeze({
    PLAY_PAUSE: 'PLAY_PAUSE',
    NEXT_TRACK: 'NEXT_TRACK',
    PREV_TRACK: 'PREV_TRACK',
    SHELF_ROTATE: 'SHELF_ROTATE',     // 旋转 3D 歌单架 (带方向 +1/-1)
    SHELF_FOCUS: 'SHELF_FOCUS'        // 聚焦/选中歌单架
  });

  // 注入的回调集 (主页面 bind)
  var _handlers = {};

  function bind(handlers) {
    _handlers = handlers || {};
  }

  function dispatch(cmd) {
    if (!cmd || !cmd.type) return;
    var h = _handlers['on' + cmd.type];
    if (typeof h !== 'function') {
      log.warn('Cmd', '未绑定 on' + cmd.type + ' 处理器, 已忽略');
      return;
    }
    try { h(cmd); } catch (e) {
      log.warn('Cmd', '派发失败', cmd.type, e && e.message || e);
    }
  }

  GE.Commands = { Type: Type, bind: bind, dispatch: dispatch };
})(window);