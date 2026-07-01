'use strict';
/**
 * gesture-engine / config.js
 * ============================================================================
 * 中央配置 (对应 Dart_Vision configs/dart.yaml).
 *
 * 所有阈值/EMA/状态机/手势映射都在这里. 热调时只动这一个文件.
 * 通过 MineradioGesture.cfg 读取, 不可直接修改运行实例 (只读视图).
 * ============================================================================
 */
(function (exports) {
  var cfg = Object.freeze({
    // -------- 相机后端 (io) --------
    camera: Object.freeze({
      // Linux 优先稳帧: 低占用识别档位 (true 时 camera.js 自动用 modelComplexity=0 + 480p)
      linuxLowPower: true,
      width: 640,
      height: 480,
      linuxWidth: 480,
      linuxHeight: 360,
      minDetectionConfidence: 0.65,    // v9: 0.70→0.65, 更快识别到手
      minTrackingConfidence: 0.60,     // v9: 0.70→0.60, 降低跟丢频率
      maxNumHands: 1,
      modelComplexity: 1,
      // CDN (MediaPipe Hands 仍走外链, 渲染页限制下无法本地 vendor 化 .wasm)
      cameraUtilsUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js',
      handsUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js',
      handsLocateBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/'
    }),

    // -------- landmark 平滑 (vision/landmarks.js) --------
    landmarks: Object.freeze({
      // 双 EMA: fast 追踪瞬时变化, slow 提供稳定基准
      handEmaIdleFast: 0.45, handEmaIdleSlow: 0.18,
      // 速度自适应: V >= V_FAST 时提到 fast 系数 (高速跟手)
      handEmaFastFast: 0.78, handEmaFastSlow: 0.42,
      // 归一化速度阈值 (单帧位移)
      handVIdle: 0.0045, handVFaster: 0.026,
      // 超过 V_FAST × IGN_BIAS 视为剧烈运动, 强制 α→1
      handVIgnBias: 2.5,
      // 3 帧加权中值: 高速时 bypass (避免延迟卡顿), 仅静止时启用
      handMaxNdcStep: 0.022
    }),

    // -------- 特征提取 (vision/features.js) --------
    features: Object.freeze({
      // 全掌速度参考点: 腕 + 5 指尖
      handSpeedIdx: [0, 4, 8, 12, 16, 20],
      // 速度 EMA 平滑本身, 避免阈值抖动
      handSpeedEma: 0.22,
      // handCurl: 五指收拢度 0(全张)~1(全收)
      //   curl = clamp(1 - (avg/span - 0.20) / 0.78, 0, 1)
      curlAvgBias: 0.20, curlScale: 0.78
    }),

    // -------- 状态机 (control/state_machine.js) --------
    // v9.3 五指收拢触发 (取代旧 pinchDist 单点), 避免手在镜头里就乱动
    state: Object.freeze({
      // curl 进入 PINCH (五指聚拢度 > 0.62 连续 3 帧)
      pinchCurlOn: 0.62,
      // curl 松开 PINCH (< 0.42 连续 2 帧) — 迟滞防抖
      pinchCurlOff: 0.42,
      // curl 进入 FIST (> 0.85 且 openness<0.28 连续 4 帧) — 更紧才算握拳
      fistCurlOn: 0.85,
      fistCurlOff: 0.65,
      // 无手超时回 IDLE (ms)
      idleTimeoutMs: 600
    }),

    // -------- aimer 手势 → 命令映射 (control/aimer.js) --------
    aimer: Object.freeze({
      // PINCH 状态下, X 方向挥动 -> 切歌
      swipeXMin: 0.18,        // 单次挥动 X 位移阈值 (归一化坐标)
      swipeCooldownMs: 700,    // 切歌冷却 (防连发)
      // PLAY_PAUSE 触发: PINCH → RELEASE 一次完整收拢→张开
      playPauseCooldownMs: 900,
      // SHELF_ROTATE: 张开手 + 横向移动
      shelfRotateOpennessMin: 0.62,
      shelfRotateCurlMax: 0.35,
      shelfRotateSwipeX: 0.10,
      shelfRotateCooldownMs: 320
    }),

    // -------- log 等级 (logger.js) --------
    logLevel: 'info'   // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  });

  // 只读视图: 防止运行时被误改
  exports.MineradioGestureCfg = exports.MineradioGestureCfg || {};
  exports.MineradioGestureCfg.cfg = cfg;
})(window);