'use strict';
/**
 * gesture-engine / vision/features.js
 * ============================================================================
 * 特征提取 (对应 Dart_Vision vision/detector 几何特征层).
 *
 * 纯几何函数, 输入: 平滑后的 21 个 landmark; 输出: 标量特征.
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var c = (window.MineradioGestureCfg || {}).cfg || {};
  var F = c.features || {};

  // 工具: clamp 0..1
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // 加权手掌中心: wrist 15% + MCP 85%, 更贴合真实手掌几何
  function palmCenter(lm) {
    var px = lm[0].x * 0.15 + (lm[5].x + lm[9].x + lm[13].x + lm[17].x) * 0.2125;
    var py = lm[0].y * 0.15 + (lm[5].y + lm[9].y + lm[13].y + lm[17].y) * 0.2125;
    return { x: px, y: py };
  }

  // 辅助推力点: 手掌中心 -> 食指尖方向偏移 0.3
  function handPushPoint(lm, palm) {
    var tipX = lm[8].x, tipY = lm[8].y;
    var dx = tipX - palm.x, dy = tipY - palm.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
    return { x: palm.x + dx / dist * dist * 0.30, y: palm.y + dy / dist * dist * 0.30 };
  }

  // openness: 张开度 0(全收)~1(全张)
  //   span = 食指根(5) - 小指根(17) 掌宽
  //   avg  = 4 指尖(8,12,16,20) 到手掌中心平均距离
  function handOpenness(lm, palm) {
    var span = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y);
    span = Math.max(0.055, span);
    var tips = [8, 12, 16, 20];
    var avg = 0;
    for (var i = 0; i < tips.length; i++) avg += Math.hypot(lm[tips[i]].x - palm.x, lm[tips[i]].y - palm.y);
    avg /= tips.length;
    return clamp01((avg / span - 0.62) / 0.78);
  }

  // curl: 五指收拢度 0(全张)~1(全收)
  //   含拇指的 5 指尖 [4,8,12,16,20] 到手掌中心平均距离 / 掌宽
  function handCurl(lm, palm) {
    var span = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y);
    span = Math.max(0.055, span);
    var tips = [4, 8, 12, 16, 20];
    var avg = 0;
    for (var i = 0; i < tips.length; i++) avg += Math.hypot(lm[tips[i]].x - palm.x, lm[tips[i]].y - palm.y);
    avg /= tips.length;
    var bias = F.curlAvgBias != null ? F.curlAvgBias : 0.20;
    var scale = F.curlScale != null ? F.curlScale : 0.78;
    return clamp01(1 - (avg / span - bias) / scale);
  }

  GE.Features = {
    palmCenter: palmCenter,
    handPushPoint: handPushPoint,
    handOpenness: handOpenness,
    handCurl: handCurl
  };
})(window);