/**
 * dsh-split-obsidian —— 布局计算（纯函数，便于离线单测）。
 *
 * ## 这个插件在做什么
 *
 * 把 DSH 和 Obsidian 两个**独立窗口**在屏幕上并排：DSH 在左、Obsidian 在右，
 * 中间留一条缝。比例可调，且侧栏里能拖动分隔条实时改变。
 *
 * 注意这不是"把 Obsidian 嵌进 DSH"——那是做不到的（Obsidian 是独立桌面程序，
 * DSH 侧栏是 webview）。这里是操作系统层面的**窗口平铺**。
 *
 * ## 坐标与缩放的坑
 *
 * 实测环境：DPI 96（100% 缩放），屏幕 1920x1080，工作区 1920x1032（底部有任务栏）。
 *
 * 一个必须记住的事实：**被最大化的窗口不能直接 MoveWindow**。
 * 实测 DSH 最大化时窗口矩形是 (-8,-8) 1936x1048 —— 比工作区还大（那是含阴影边框的
 * 尺寸），此时调 MoveWindow 会被系统忽略。所以并排前必须先取消最大化。
 *
 * 所有计算都基于**工作区**（WorkingArea）而不是整屏，否则窗口会被任务栏盖住。
 */

/** 比例的安全范围：太窄的两个窗口都没法用。 */
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

/** 两个窗口之间留的缝（像素），让边界看得清。 */
export const DEFAULT_GAP = 8;

/** 把比例夹到安全范围，并挡住 NaN。 */
export function clampRatio(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0.62;
  if (n < MIN_RATIO) return MIN_RATIO;
  if (n > MAX_RATIO) return MAX_RATIO;
  return n;
}

/**
 * 由工作区与比例算出两个窗口的矩形。
 *
 * @param work - { x, y, width, height }，来自 Screen.PrimaryScreen.WorkingArea
 * @param ratio - DSH 占的宽度比例（0.2 ~ 0.8）
 * @param gap - 中间缝隙
 * @returns { left, right }，各是 { x, y, width, height }
 */
export function computeSideBySide(work, ratio, gap) {
  const x = Number(work?.x ?? 0);
  const y = Number(work?.y ?? 0);
  const width = Math.max(0, Number(work?.width ?? 0));
  const height = Math.max(0, Number(work?.height ?? 0));
  const g = typeof gap === "number" && Number.isFinite(gap) ? Math.max(0, gap) : DEFAULT_GAP;
  const r = clampRatio(ratio);

  // 先给左侧取整，右侧用"剩余"而不是再乘一次比例 —— 这样两边相加永远等于总宽，
  // 不会因为两次四舍五入在接缝处差 1px。
  const leftWidth = Math.round(width * r);
  const rightWidth = Math.max(0, width - leftWidth - g);

  return {
    left: { x: x, y: y, width: leftWidth, height: height },
    right: { x: x + leftWidth + g, y: y, width: rightWidth, height: height },
    gap: g,
    ratio: r
  };
}

/** 整块工作区（用于"最大化"某个窗口）。 */
export function computeFull(work) {
  return {
    x: Number(work?.x ?? 0),
    y: Number(work?.y ?? 0),
    width: Math.max(0, Number(work?.width ?? 0)),
    height: Math.max(0, Number(work?.height ?? 0))
  };
}

/**
 * 由"分隔条在屏幕上的横坐标"反推 DSH 的宽度比例。
 * 拖动时客户端把鼠标的屏幕 X 传过来，这里换算成比例。
 */
export function ratioFromSplitX(work, splitX, gap) {
  const x = Number(work?.x ?? 0);
  const width = Math.max(1, Number(work?.width ?? 1));
  const g = typeof gap === "number" && Number.isFinite(gap) ? Math.max(0, gap) : DEFAULT_GAP;
  // 分隔条位于左侧窗口右边缘；右侧从 分隔条 + gap 开始
  const leftWidth = Number(splitX) - x;
  return clampRatio(leftWidth / width);
}

/** 预设档位，给"点一下换个比例"用。 */
export const PRESETS = [0.5, 0.62, 0.7, 0.38];

/** 生成可读的比例文案。 */
export function describeRatio(ratio) {
  const r = clampRatio(ratio);
  const left = Math.round(r * 100);
  return left + " : " + (100 - left);
}
