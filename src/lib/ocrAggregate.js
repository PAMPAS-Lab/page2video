/**
 * ocrAggregate.js — OCR 原始行的后处理（面积过滤 + VLM 区块重合过滤 + 行聚合）
 *
 * 针对强调动画场景：原始 OCR（阿里云 Block 级）粒度过细，需聚焦"段落级语义单元"。
 *
 * 处理管道：
 *   原始 lines → 面积阈值过滤 → VLM 图表区域内文字过滤 → 行聚合（可选）
 *
 * 纯函数、零依赖、可测试。
 *
 * 输入输出约定：
 *   line = { text, bboxNorm:[x,y,w,h] ∈ [0,1], confidence, ... }
 *   block = { kind, bboxNorm:[x,y,w,h] ∈ [0,1], ... }
 */

// ── 默认参数（沿用规范：强调动画 OCR 面积阈值 0.003）───────────
const DEFAULT_AREA_THRESHOLD = 0.003;

// 这些 VLM kind 视为"视觉/公式/表格"区域，内部 OCR 文字不参与强调动画
const DEFAULT_VLM_EXCLUDE_KINDS = ['image', 'chart', 'diagram', 'formula', 'table'];

// 行聚合参数：同行纵向间隔容忍（相对行高），相邻块横向间隔容忍（相对行高）
const DEFAULT_AGGREGATE_OPTS = {
  yGapRatio: 0.6, // 两个 OCR 块 yCenter 差 < 行高 * yGapRatio 视为同行
  xGapRatio: 1.5, // 同行内两个块 x 间隔 < 行高 * xGapRatio 视为相邻可合并
};

// ── 基础几何 ───────────────────────────────────────────

function bboxArea(b) {
  const [, , w, h] = b || [0, 0, 0, 0];
  return (Number(w) || 0) * (Number(h) || 0);
}

function bboxCentroid(b) {
  const [x, y, w, h] = b || [0, 0, 0, 0];
  return [x + w / 2, y + h / 2];
}

function pointInBbox(px, py, [x, y, w, h]) {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

// 两 bbox 的 IoU（交并比）
function bboxIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ix = Math.max(ax, bx);
  const iy = Math.max(ay, by);
  const ix2 = Math.min(ax + aw, bx + bw);
  const iy2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// ── 过滤器 1：面积阈值 ────────────────────────────────

function filterByArea(lines, threshold = DEFAULT_AREA_THRESHOLD) {
  const kept = [];
  const dropped = [];
  for (const l of lines) {
    const a = bboxArea(l.bboxNorm);
    if (a >= threshold) kept.push(l);
    else dropped.push({ ...l, _dropReason: `area<${threshold}(a=${a.toFixed(4)})` });
  }
  return { kept, dropped };
}

// ── 过滤器 2：VLM 图表/图像区域内 OCR 文字过滤 ──────────
// 判定规则：OCR 行 bbox 质心落入某个 VLM 排除区块 内 → 过滤
//           或 IoU > iouThreshold（防止跨骑小块也被完全吞掉）

function filterByVlmOverlap(
  lines,
  blocks,
  { excludeKinds = DEFAULT_VLM_EXCLUDE_KINDS, iouThreshold = 0.5 } = {}
) {
  const excludeBoxes = (blocks || []).filter(b => excludeKinds.includes(b.kind) && b.bboxNorm);
  if (!excludeBoxes.length) return { kept: lines.slice(), dropped: [] };

  const kept = [];
  const dropped = [];
  for (const l of lines) {
    const [cx, cy] = bboxCentroid(l.bboxNorm);
    let hit = null;
    for (const eb of excludeBoxes) {
      if (pointInBbox(cx, cy, eb.bboxNorm)) { hit = eb; break; }
      if (bboxIoU(l.bboxNorm, eb.bboxNorm) >= iouThreshold) { hit = eb; break; }
    }
    if (hit) {
      dropped.push({ ...l, _dropReason: `inside-vlm-${hit.kind}#${hit.id || '?'}` });
    } else {
      kept.push(l);
    }
  }
  return { kept, dropped };
}

// ── 行聚合：按 yCenter 聚类 + 同簇内 x 相邻合并 ────────

function aggregateRows(lines, opts = {}) {
  const { yGapRatio, xGapRatio } = { ...DEFAULT_AGGREGATE_OPTS, ...opts };
  if (!lines.length) return [];

  // 1. 以 yCenter 升序排
  const sorted = lines
    .map((l, i) => ({
      ref: l,
      _orig: i,
      _yc: (l.bboxNorm[1] || 0) + (l.bboxNorm[3] || 0) / 2,
      _h: l.bboxNorm[3] || 0,
    }))
    .sort((a, b) => a._yc - b._yc);

  // 2. 行聚类（顺扫，gap < 行高 * yGapRatio 则并入当前行）
  const rowBuckets = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = cur[cur.length - 1];
    const gap = sorted[i]._yc - prev._yc;
    const tol = Math.max(prev._h, sorted[i]._h) * yGapRatio;
    if (gap <= tol) cur.push(sorted[i]);
    else {
      rowBuckets.push(cur);
      cur = [sorted[i]];
    }
  }
  rowBuckets.push(cur);

  // 3. 每行内按 x 排序，相邻块合并
  const out = [];
  for (const row of rowBuckets) {
    row.sort((a, b) => (a.ref.bboxNorm[0] || 0) - (b.ref.bboxNorm[0] || 0));

    let group = [row[0]];
    const flushGroup = () => {
      const items = group.map(g => g.ref);
      const xs = items.flatMap(l => [l.bboxNorm[0], l.bboxNorm[0] + l.bboxNorm[2]]);
      const ys = items.flatMap(l => [l.bboxNorm[1], l.bboxNorm[1] + l.bboxNorm[3]]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      const confList = items.map(l => l.confidence).filter(c => c != null);
      const avgConf = confList.length ? confList.reduce((s, c) => s + c, 0) / confList.length : null;
      out.push({
        text: items.map(l => l.text || '').join(' ').replace(/\s+/g, ' ').trim(),
        bboxNorm: [x, y, w, h],
        confidence: avgConf,
        _src: 'aggregated',
        _mergedFrom: items.length,
        _mergedTexts: items.map(l => l.text),
      });
      group = [];
    };

    for (let i = 1; i < row.length; i++) {
      const prev = group[group.length - 1];
      const prevRight = prev.ref.bboxNorm[0] + prev.ref.bboxNorm[2];
      const gap = row[i].ref.bboxNorm[0] - prevRight;
      const tol = Math.max(prev.ref.bboxNorm[3], row[i].ref.bboxNorm[3]) * xGapRatio;
      if (gap <= tol) group.push(row[i]);
      else {
        flushGroup();
        group = [row[i]];
      }
    }
    if (group.length) flushGroup();
  }

  return out;
}

// ── 统一入口 ───────────────────────────────────────────
/**
 * @param {Array} lines 原始 OCR 行
 * @param {Array} blocks VLM 区块（用于排除图表/图像内部文字）
 * @param {Object} opts
 *   - mode: 'raw' | 'filter' | 'rows'（默认 'rows'）
 *   - areaThreshold: number（默认 0.003）
 *   - excludeKinds: string[]（默认 DEFAULT_VLM_EXCLUDE_KINDS）
 *   - iouThreshold: number（默认 0.5）
 *   - aggregate: { yGapRatio, xGapRatio }
 * @returns {{ kept, dropped, stats }}
 */
function processOcrLines(lines, blocks = [], opts = {}) {
  const {
    mode = 'rows',
    areaThreshold = DEFAULT_AREA_THRESHOLD,
    excludeKinds = DEFAULT_VLM_EXCLUDE_KINDS,
    iouThreshold = 0.5,
    aggregate = {},
  } = opts;

  const srcLines = Array.isArray(lines) ? lines : [];
  const droppedAll = [];
  const stats = { inputCount: srcLines.length, afterArea: 0, afterVlmOverlap: 0, finalCount: 0 };

  if (mode === 'raw') {
    stats.afterArea = srcLines.length;
    stats.afterVlmOverlap = srcLines.length;
    stats.finalCount = srcLines.length;
    return { kept: srcLines, dropped: [], stats, mode };
  }

  // Step 1: 面积过滤
  const s1 = filterByArea(srcLines, areaThreshold);
  droppedAll.push(...s1.dropped);
  stats.afterArea = s1.kept.length;

  // Step 2: VLM 区块重合过滤
  const s2 = filterByVlmOverlap(s1.kept, blocks, { excludeKinds, iouThreshold });
  droppedAll.push(...s2.dropped);
  stats.afterVlmOverlap = s2.kept.length;

  if (mode === 'filter') {
    stats.finalCount = s2.kept.length;
    return {
      kept: s2.kept,
      dropped: droppedAll,
      stats,
      mode,
      params: { areaThreshold, excludeKinds, iouThreshold },
    };
  }

  // Step 3: 行聚合
  const aggregated = aggregateRows(s2.kept, aggregate);
  stats.finalCount = aggregated.length;
  return {
    kept: aggregated,
    dropped: droppedAll,
    stats,
    mode,
    params: { areaThreshold, excludeKinds, iouThreshold, aggregate: { ...DEFAULT_AGGREGATE_OPTS, ...aggregate } },
  };
}

module.exports = {
  DEFAULT_AREA_THRESHOLD,
  DEFAULT_VLM_EXCLUDE_KINDS,
  DEFAULT_AGGREGATE_OPTS,
  bboxArea,
  bboxIoU,
  filterByArea,
  filterByVlmOverlap,
  aggregateRows,
  processOcrLines,
};
