'use strict';
/**
 * gesture-engine / vision/detector.js
 * ============================================================================
 * 识别器 (对应 Dart_Vision vision::GreenLightDetector : dart::IDetector).
 *
 * 把上层传入的 raw landmarks -> 平滑 -> 抽取特征 -> 组装 GestureFrame.
 * GestureFrame 是 vision -> control 之间流转的共享结构 (对应 DartTarget).
 * ============================================================================
 */
(function (exports) {
  var GE = exports.MineradioGesture || (exports.MineradioGesture = {});
  var Features = (GE.Features || {});
  var Landmarks = (GE.Landmarks || {});

  // GestureFrame: 单帧检测结果 (持久复用对象)
  function makeFrame() {
    return {
      hasHand: false,         // 本帧是否检测到手
      // 平滑后的 21 个 landmark (复用引用, 调用方不应假定是新对象)
      lm: null,
      palm: { x: 0, y: 0 },
      pushPt: { x: 0, y: 0 },
      openness: 0,            // 张开度 0~1
      curl: 0,                // 五指收拢度 0~1 (1=全收)
      speed: 0,               // 全掌速度 (归一化)
      timestamp: 0
    };
  }

  // 内部平滑缓冲 (跨帧持久)
  var _handLmSmooth = null;

  function reset() {
    _handLmSmooth = null;
    if (Landmarks.reset) Landmarks.reset();
  }

  /**
   * @param  {Array|null} rawLm  raw MediaPipe landmarks, null -> 丢失
   * @param  {GestureFrame} out  复用输出对象 (避免 per-frame 分配)
   * @return {GestureFrame}
   */
  function detect(rawLm, out) {
    if (!rawLm) {
      out.hasHand = false;
      out.timestamp = performance.now();
      return out;
    }
    // 平滑 (跨帧 buffer)
    _handLmSmooth = Landmarks.smooth(rawLm, _handLmSmooth);
    out.lm = _handLmSmooth;

    var palm = Features.palmCenter(_handLmSmooth);
    out.palm.x = palm.x; out.palm.y = palm.y;
    var push = Features.handPushPoint(_handLmSmooth, palm);
    out.pushPt.x = push.x; out.pushPt.y = push.y;
    out.openness = Features.handOpenness(_handLmSmooth, palm);
    out.curl = Features.handCurl(_handLmSmooth, palm);
    out.speed = Landmarks.getSpeed ? Landmarks.getSpeed() : 0;
    out.hasHand = true;
    out.timestamp = performance.now();
    return out;
  }

  GE.GestureFrame = makeFrame;
  GE.HandDetector = { detect: detect, reset: reset };
})(window);