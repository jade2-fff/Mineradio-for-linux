const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
  window: {},
  console,
};
context.window.window = context.window;
context.window.log = { debug() {}, info() {}, warn() {}, error() {} };
context.log = context.window.log;
vm.createContext(context);

['public/gesture-engine/config.js', 'public/gesture-engine/control/state_machine.js', 'public/gesture-engine/control/commands.js', 'public/gesture-engine/control/aimer.js']
  .forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file }));

const GE = context.window.MineradioGesture;
const ST = GE.StateMachine.ST;

function frame(y, speed, ts) {
  return { timestamp: ts, palm: { x: 0.5, y }, speed: speed == null ? 0.04 : speed, curl: 0.7, openness: 0.2 };
}

GE.StateMachine.reset();
GE.Aimer.reset();
GE.StateMachine.transition(ST.PINCH);
let cmds = GE.Aimer.decide(frame(0.50, 0.04, 1000), ST.HOVER);
assert.strictEqual(cmds.length, 0);
cmds = GE.Aimer.decide(frame(0.34, 0.04, 1260), ST.PINCH);
assert.strictEqual(cmds.length, 1);
assert.strictEqual(cmds[0].type, GE.Commands.Type.NEXT_TRACK, '上划应切到下一首');

GE.StateMachine.reset();
GE.Aimer.reset();
GE.StateMachine.transition(ST.PINCH);
GE.Aimer.decide(frame(0.50, 0.04, 2000), ST.HOVER);
cmds = GE.Aimer.decide(frame(0.66, 0.04, 2260), ST.PINCH);
assert.strictEqual(cmds.length, 1);
assert.strictEqual(cmds[0].type, GE.Commands.Type.PREV_TRACK, '下划应切到上一首');

GE.StateMachine.reset();
GE.Aimer.reset();
GE.StateMachine.transition(ST.PINCH);
GE.Aimer.decide(frame(0.50, 0.004, 3000), ST.HOVER);
cmds = GE.Aimer.decide(frame(0.41, 0.004, 3260), ST.PINCH);
assert.strictEqual(cmds.length, 0, '慢速小幅移动不应误触切歌');

// 防误触: 挥手切歌(有挥动意图)后进入 RELEASE, 不应误触 PLAY_PAUSE
GE.StateMachine.reset();
GE.Aimer.reset();
GE.StateMachine.transition(ST.PINCH);
GE.Aimer.decide(frame(0.50, 0.04, 4000), ST.HOVER);       // 进入 PINCH 记录起点
var swipeCmds = GE.Aimer.decide(frame(0.34, 0.04, 4260), ST.PINCH);  // 上划切歌(有挥动意图)
assert.strictEqual(swipeCmds.length, 1);
assert.strictEqual(swipeCmds[0].type, GE.Commands.Type.NEXT_TRACK);
// 手指松开: 状态转 RELEASE, aimer 读到 st=RELEASE 且 prevState=PINCH
GE.StateMachine.transition(ST.RELEASE);
var releaseCmds = GE.Aimer.decide(frame(0.34, 0.01, 4400), ST.PINCH);
var hasPlayPause = releaseCmds.some(function(c){ return c.type === GE.Commands.Type.PLAY_PAUSE; });
assert.strictEqual(hasPlayPause, false, '挥手切歌后松手不应误触 PLAY_PAUSE');

// 纯收拢->张开(无挥动)仍应触发 PLAY_PAUSE
GE.StateMachine.reset();
GE.Aimer.reset();
GE.StateMachine.transition(ST.PINCH);
GE.Aimer.decide(frame(0.50, 0.004, 6000), ST.HOVER);      // 进入 PINCH, 几乎不动
GE.Aimer.decide(frame(0.50, 0.004, 6100), ST.PINCH);      // 保持, 无挥动
GE.StateMachine.transition(ST.RELEASE);
var ppCmds = GE.Aimer.decide(frame(0.50, 0.004, 6200), ST.PINCH);  // st=RELEASE prev=PINCH
var gotPlayPause = ppCmds.some(function(c){ return c.type === GE.Commands.Type.PLAY_PAUSE; });
assert.strictEqual(gotPlayPause, true, '纯收拢张开(无挥动)应触发 PLAY_PAUSE');

console.log('ok');
