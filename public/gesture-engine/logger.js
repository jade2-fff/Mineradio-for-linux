'use strict';
/**
 * gesture-engine / logger.js
 * ============================================================================
 * 统一日志 (对应 Dart_Vision spdlog).
 * 分级 + 模块前缀, 避免 console 红字噪音. 通过 MineradioGesture.log 访问.
 * ============================================================================
 */
(function (exports) {
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  var currentLevel = LEVELS.info;

  function setLevel(name) {
    currentLevel = LEVELS[name] != null ? LEVELS[name] : LEVELS.info;
  }
  function shouldLog(lv) { return lv >= currentLevel; }

  function makeTag(mod) { return mod != null ? ('[Gesture/' + mod + ']') : '[Gesture]'; }
  function emit(lv, mod, args) {
    if (!shouldLog(lv)) return;
    var tag = makeTag(mod);
    // 按等级选择 console 方法, 不污染 stdout 管道 (server.js EPIPE 教训)
    if (lv >= LEVELS.error) console.error.apply(console, [tag].concat(args));
    else if (lv >= LEVELS.warn) console.warn.apply(console, [tag].concat(args));
    else if (lv >= LEVELS.info) console.info ? console.info.apply(console, [tag].concat(args)) : console.log.apply(console, [tag].concat(args));
    else console.log.apply(console, [tag].concat(args));
  }

  var log = {
    setLevel: setLevel,
    debug: function (mod) { emit(LEVELS.debug, mod, Array.prototype.slice.call(arguments, 1)); },
    info:  function (mod) { emit(LEVELS.info,  mod, Array.prototype.slice.call(arguments, 1)); },
    warn:  function (mod) { emit(LEVELS.warn,  mod, Array.prototype.slice.call(arguments, 1)); },
    error: function (mod) { emit(LEVELS.error, mod, Array.prototype.slice.call(arguments, 1)); }
  };

  exports.log = log;
})(window);