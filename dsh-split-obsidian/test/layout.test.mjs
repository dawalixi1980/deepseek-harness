/**
 * dsh-split-obsidian 测试。
 *
 * 布局计算是纯函数，覆盖：比例夹取、两窗相加恒等于总宽、拖动反推、预设与文案。
 * 窗口操作（Win32）不在这里测 —— 那需要真实窗口，放进 scripts/probe-windows.mjs 手动跑。
 */
import {
  clampRatio,
  computeFull,
  computeSideBySide,
  DEFAULT_GAP,
  describeRatio,
  MAX_RATIO,
  MIN_RATIO,
  PRESETS,
  ratioFromSplitX
} from "../lib/layout.js";

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log("  PASS  " + name); }
  else { failed += 1; console.log("  FAIL  " + name + (detail ? "\n        " + detail : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

// 实测环境：1920x1080 屏幕，工作区 1920x1032（底部任务栏 48px）
const WORK = { x: 0, y: 0, width: 1920, height: 1032 };

section("比例夹取");
check("正常值原样返回", clampRatio(0.5) === 0.5);
check("低于下限被夹到 0.2", clampRatio(0.05) === MIN_RATIO);
check("高于上限被夹到 0.8", clampRatio(0.95) === MAX_RATIO);
check("NaN 回落到默认 0.62", clampRatio(Number.NaN) === 0.62);
check("非数字回落到默认", clampRatio("x") === 0.62);
check("边界值 0.2 保留", clampRatio(0.2) === 0.2);
check("边界值 0.8 保留", clampRatio(0.8) === 0.8);

section("并排矩形");
for (const r of [0.2, 0.3, 0.5, 0.62, 0.7, 0.8]) {
  const s = computeSideBySide(WORK, r, DEFAULT_GAP);
  const sum = s.left.width + s.gap + s.right.width;
  check("比例 " + describeRatio(r) + " 两窗加缝隙 = 总宽", sum === WORK.width, "得到 " + sum);
  check("比例 " + describeRatio(r) + " 左侧从 x=0 起", s.left.x === 0);
  check("比例 " + describeRatio(r) + " 右侧接在左窗+缝隙之后", s.right.x === s.left.width + s.gap);
  check("比例 " + describeRatio(r) + " 高度都等于工作区高", s.left.height === WORK.height && s.right.height === WORK.height);
}

section("取整不会在接缝处漏像素");
{
  // 用一个除不尽的宽度，验证"右侧取剩余"而不是"右侧再乘一次比例"
  const odd = { x: 0, y: 0, width: 1919, height: 1032 };
  for (const r of [0.333, 0.617, 0.271]) {
    const s = computeSideBySide(odd, r, 7);
    check("宽度 1919 比例 " + r + " 仍加总相等", s.left.width + 7 + s.right.width === 1919);
  }
}

section("带偏移的工作区");
{
  // 多显示器时工作区可能不从 (0,0) 开始
  const off = { x: 1920, y: 0, width: 1920, height: 1032 };
  const s = computeSideBySide(off, 0.5, 8);
  check("左窗从工作区原点开始", s.left.x === 1920);
  check("右窗偏移正确", s.right.x === 1920 + s.left.width + 8);
  check("加总仍等于总宽", s.left.width + 8 + s.right.width === 1920);
}

section("拖动反推比例");
{
  const s = computeSideBySide(WORK, 0.62, 8);
  const back = ratioFromSplitX(WORK, s.left.width, 8);
  /*
   * 反推必然有取整误差：left.width 是 Math.round(1920*0.62)=1190，
   * 反推 1190/1920 = 0.619791...，与 0.62 差 0.0002 —— 这是 1px 的量化误差，
   * 不是 bug。断言用一个像素的容差（1/1920 ≈ 0.00052）。
   */
  const onePixel = 1 / WORK.width;
  check("由分隔条位置反推回同一个比例（1px 内）", Math.abs(back - 0.62) <= onePixel, "得到 " + back + "，容差 " + onePixel);
  check("反推结果也被夹取", ratioFromSplitX(WORK, -500, 8) === MIN_RATIO);
  check("反推超出右边界被夹取", ratioFromSplitX(WORK, 5000, 8) === MAX_RATIO);
}

section("整块工作区");
{
  const full = computeFull(WORK);
  check("等于工作区本身", full.x === 0 && full.y === 0 && full.width === 1920 && full.height === 1032);
  check("缺字段时退化为 0 而不是 NaN", computeFull({}).width === 0);
}

section("描述与预设");
check("0.62 -> 62 : 38", describeRatio(0.62) === "62 : 38");
check("0.5 -> 50 : 50", describeRatio(0.5) === "50 : 50");
check("预设都在合法区间内", PRESETS.every((p) => p >= MIN_RATIO && p <= MAX_RATIO));
check("预设数量 >= 3", PRESETS.length >= 3);

section("异常输入");
check("空工作区不抛错", (() => { try { computeSideBySide({}, 0.5, 8); return true; } catch { return false; } })());
check("比例 NaN 时仍能得到合法布局", (() => { const s = computeSideBySide(WORK, Number.NaN, 8); return s.left.width > 0 && s.right.width > 0; })());
check("缝隙为负时按 0 处理", (() => { const s = computeSideBySide(WORK, 0.5, -10); return s.gap === 0; })());

console.log("\n" + (failed === 0 ? "全部通过" : "有失败") + "：" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
