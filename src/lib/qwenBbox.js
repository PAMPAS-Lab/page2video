/**
 * qwenBbox.js — Qwen-VL Grounding 坐标转换工具
 *
 * 背景：Qwen-VL 系列在 Grounding 任务上原生输出 `bbox_2d: [x1, y1, x2, y2]`，
 *       数值是相对于"模型实际看到的图像分辨率"的绝对像素坐标。
 *       DashScope 接到图像后通常会内部 resize（例如 1921×1080 → 1600×900），
 *       因此模型必须在 JSON 中同时返回 imageSize: { w, h } 报告它实际看到的分辨率。
 *       项目下游统一使用 `bboxNorm: [x, y, w, h]`（[0,1] 归一化、x,y 是左上角）。
 *
 * 本模块提供：
 *   - bbox2dToNorm(bbox2d, canvasW, canvasH)
 *       把 [x1,y1,x2,y2] 按指定画布尺寸归一化为 [x,y,w,h]
 *   - normalizeBlockBbox(block, canvas)
 *       规范化单个 block，附带 _bboxRaw / _bboxOverflow 等诊断字段
 *   - normalizeVlmResult(parsed)
 *       规范化整个 VLM 输出。会从 parsed.imageSize 读取画布尺寸，
 *       缺失时回退到 1000×1000（旧 prompt 兼容）。
 *
 * 兼容性（解析顺序）：
 *   1) 标准新格式：parsed.imageSize.{w,h} + bbox_2d 绝对像素
 *   2) 缺失 imageSize：用 1000×1000 兜底（旧 prompt）
 *   3) bbox_2d 但取值 [0,1]：当作 [x1,y1,x2,y2] 直接换算
 *   4) 兼容旧 bboxNorm = [x,y,w,h]
 *   5) 兜底：保留 _bboxIssue 字段供调试
 *
 * 设计原则：纯函数，无外部依赖；Node 与浏览器均可运行。
 */

const FALLBACK_CANVAS = 1000;

function clamp01(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function pickCanvas(canvas) {
  const w = Number(canvas && canvas.w);
  const h = Number(canvas && canvas.h);
  const valid = Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0;
  // 保留上游传入的 fallback 标记（避免嵌套调用时丢失）
  const upstreamFallback = canvas && canvas.fallback === true;
  return {
    w: valid ? w : FALLBACK_CANVAS,
    h: valid ? h : FALLBACK_CANVAS,
    fallback: !valid || upstreamFallback,
  };
}

/**
 * 把 [x1,y1,x2,y2] 按画布 (canvasW × canvasH) 归一化为 [x,y,w,h]
 * @param {[number,number,number,number]} bbox2d
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {{ bboxNorm:[number,number,number,number], overflow:boolean, swapped:boolean }}
 */
function bbox2dToNorm(bbox2d, canvasW = FALLBACK_CANVAS, canvasH = FALLBACK_CANVAS) {
  let [x1, y1, x2, y2] = bbox2d.map(v => Number(v));
  // 处理颠倒
  let swapped = false;
  if (x1 > x2) { [x1, x2] = [x2, x1]; swapped = true; }
  if (y1 > y2) { [y1, y2] = [y2, y1]; swapped = true; }
  // 越界检测（容忍 0.5 像素抖动）
  const overflow =
    x1 < 0 || y1 < 0 ||
    x2 > canvasW + 0.5 || y2 > canvasH + 0.5;
  // 归一化 + clamp
  const nx1 = clamp01(x1 / canvasW);
  const ny1 = clamp01(y1 / canvasH);
  const nx2 = clamp01(x2 / canvasW);
  const ny2 = clamp01(y2 / canvasH);
  return {
    bboxNorm: [nx1, ny1, Math.max(0, nx2 - nx1), Math.max(0, ny2 - ny1)],
    overflow,
    swapped,
  };
}

/**
 * 判断 bbox_2d 数组的数值是绝对像素还是 [0,1] 归一化
 * 启发式：任一值 > 1.5 → 绝对像素；否则视为 [0,1] 系
 */
function looksLikeAbsolutePixels(arr) {
  return arr.some(v => Number(v) > 1.5);
}

/**
 * 规范化单个 block：补 bboxNorm，附加诊断字段
 * 不会丢弃 block；解析失败时会标记 _bboxIssue
 * @param {object} block
 * @param {{w:number,h:number,fallback?:boolean}} canvas  画布尺寸（来自 parsed.imageSize）
 */
function normalizeBlockBbox(block, canvas) {
  const c = pickCanvas(canvas);
  const out = { ...block };
  // 1) 优先 bbox_2d
  if (Array.isArray(block.bbox_2d) && block.bbox_2d.length === 4) {
    out._bboxRaw = { source: 'bbox_2d', value: block.bbox_2d };
    out._bboxCanvas = { w: c.w, h: c.h, fallback: c.fallback };
    if (looksLikeAbsolutePixels(block.bbox_2d)) {
      const r = bbox2dToNorm(block.bbox_2d, c.w, c.h);
      out.bboxNorm = r.bboxNorm;
      out._bboxOverflow = r.overflow;
      out._bboxSwapped = r.swapped;
      if (c.fallback) {
        out._bboxNote = `imageSize 未提供，用 ${FALLBACK_CANVAS}×${FALLBACK_CANVAS} 兜底归一化（结果可能不准）`;
      }
    } else {
      // bbox_2d 取值 [0,1]：当作 [x1,y1,x2,y2] 比例直接换算
      const [x1, y1, x2, y2] = block.bbox_2d.map(Number);
      const r = bbox2dToNorm([x1 * 1000, y1 * 1000, x2 * 1000, y2 * 1000], 1000, 1000);
      out.bboxNorm = r.bboxNorm;
      out._bboxOverflow = r.overflow;
      out._bboxSwapped = r.swapped;
      out._bboxNote = 'bbox_2d 值在 [0,1] 区间，按 [x1,y1,x2,y2] 比例解析';
    }
    return out;
  }
  // 2) 兼容旧 bboxNorm（[x,y,w,h] 或可能是 [x1,y1,x2,y2]）
  if (Array.isArray(block.bboxNorm) && block.bboxNorm.length === 4) {
    out._bboxRaw = { source: 'bboxNorm-legacy', value: block.bboxNorm };
    const [a, b, c2, d] = block.bboxNorm.map(Number);
    // 启发式：若 c > a 且 d > b，且 a+c 或 b+d 严格超出 1，更可能是 [x1,y1,x2,y2]
    const looksLikeXYXY = c2 > a && d > b && (a + c2 > 1.001 || b + d > 1.001);
    if (looksLikeXYXY) {
      const r = bbox2dToNorm([a * 1000, b * 1000, c2 * 1000, d * 1000], 1000, 1000);
      out.bboxNorm = r.bboxNorm;
      out._bboxOverflow = r.overflow;
      out._bboxSwapped = r.swapped;
      out._bboxNote = '旧 bboxNorm 字段疑似 [x1,y1,x2,y2]，已修正';
    } else {
      out.bboxNorm = [clamp01(a), clamp01(b), clamp01(c2), clamp01(d)];
      out._bboxOverflow = (a + c2 > 1.001 || b + d > 1.001 || a < 0 || b < 0);
    }
    return out;
  }
  // 3) 解析失败
  out.bboxNorm = [0, 0, 0, 0];
  out._bboxIssue = '无法识别的 bbox 格式';
  return out;
}

/**
 * 规范化 VLM 解析结果：返回 { ...parsed, blocks: [normalizedBlock...] }
 *
 * 重要：本项目采用 Qwen-VL Grounding 官方标准 1000×1000 千分位画布（与原图真实分辨率无关）。
 * 模型仅是在提示词要求下填入 imageSize，实际 bbox_2d 变量始终用 1000 千分位输出（这是它训练期形成的习惯、不会因 prompt 谎言而改变）。
 * 因此：强制用 1000×1000 反归一化，parsed.imageSize 仅当作诊断信息保留。
 */
function normalizeVlmResult(parsed) {
  if (!parsed || !Array.isArray(parsed.blocks)) {
    return {
      blocks: [],
      _normalizedSchema: 'qwen-bbox-1000',
      _diagnostic: 'no blocks in parsed',
    };
  }
  const declaredImageSize = parsed.imageSize || null;
  // 固定使用 1000×1000 官方画布
  const canvas = { w: FALLBACK_CANVAS, h: FALLBACK_CANVAS, fallback: false };
  return {
    ...parsed,
    blocks: parsed.blocks.map(b => normalizeBlockBbox(b, canvas)),
    _normalizedSchema: 'qwen-bbox-1000',
    _normalizedCanvas: { w: canvas.w, h: canvas.h, fallback: false },
    _declaredImageSize: declaredImageSize,  // 仅作审计，不参与反归一化
  };
}

module.exports = {
  FALLBACK_CANVAS,
  // 旧导出别名（保留向后兼容）
  QWEN_CANVAS: FALLBACK_CANVAS,
  bbox2dToNorm,
  normalizeBlockBbox,
  normalizeVlmResult,
};
