const fs = require('fs');
const path = require('path');

/**
 * emphasisPlanSchema.js — AnimationPlan Schema 校验器
 * 
 * 纯函数 validator，用于验证 emphasisAnnotationAgent 输出的 AnimationPlan
 * 和前端 useEmphasisPlan 中接收到的 plan 数据。
 */

// ── 常量 ──────────────────────────────────────────────────

const VALID_EMPHASIS_KINDS = new Set(['text', 'block', 'subtitle']);
const VALID_EMPHASIS_TYPES = new Set(['text-highlight', 'glow-pulse', 'subtitle']);
// 底端字幕条固定 bbox：底部 12% 高度，左右各留 5%
const SUBTITLE_BBOX_NORM = [0.05, 0.85, 0.90, 0.12];
const MAX_EMPHASES = 10; // Canvas 内截断上限

// ── 校验函数 ─────────────────────────────────────────────

/**
 * 校验单个 emphasis 条目
 * @param {object} emp
 * @param {number} index - 在 emphases 数组中的索引
 * @returns {string[]} 错误消息数组，空数组表示通过
 */
function validateEmphasis(emp, index = 0) {
  const errors = [];
  const prefix = `emphases[${index}]`;

  if (!emp || typeof emp !== 'object') {
    errors.push(`${prefix}: 必须是对象`);
    return errors;
  }

  // order
  if (typeof emp.order !== 'number' || emp.order < 1) {
    errors.push(`${prefix}.order: 必须为正整数，当前值=${emp.order}`);
  }

  // start / end
  if (typeof emp.start !== 'number' || emp.start < 0) {
    errors.push(`${prefix}.start: 必须为非负数，当前值=${emp.start}`);
  }
  if (typeof emp.end !== 'number' || emp.end < 0) {
    errors.push(`${prefix}.end: 必须为非负数，当前值=${emp.end}`);
  }
  if (typeof emp.start === 'number' && typeof emp.end === 'number' && emp.start >= emp.end) {
    errors.push(`${prefix}: start(${emp.start}) 必须小于 end(${emp.end})`);
  }

  // kind
  if (!VALID_EMPHASIS_KINDS.has(emp.kind)) {
    errors.push(`${prefix}.kind: 必须是 "text" / "block" / "subtitle"，当前值="${emp.kind}"`);
  }

  // bboxNorm
  if (!Array.isArray(emp.bboxNorm) || emp.bboxNorm.length !== 4) {
    errors.push(`${prefix}.bboxNorm: 必须是 [x, y, w, h] 数组，当前值=${JSON.stringify(emp.bboxNorm)}`);
  } else {
    const [x, y, w, h] = emp.bboxNorm;
    for (const [name, val] of [['x', x], ['y', y], ['w', w], ['h', h]]) {
      if (typeof val !== 'number' || val < -0.01 || val > 1.01) {
        errors.push(`${prefix}.bboxNorm[${name}]: 必须为 0-1 之间，当前值=${val}`);
      }
    }
    // clamp 会自动处理，但这里告警
  }

  // confidence
  if (typeof emp.confidence !== 'number' || emp.confidence < 0 || emp.confidence > 1) {
    errors.push(`${prefix}.confidence: 必须为 0-1 之间，当前值=${emp.confidence}`);
  }

  // type
  if (!VALID_EMPHASIS_TYPES.has(emp.type)) {
    errors.push(`${prefix}.type: 必须是 "text-highlight" / "glow-pulse" / "subtitle"，当前值="${emp.type}"`);
  }

  // keyword (optional but recommended)
  if (emp.keyword !== undefined && typeof emp.keyword !== 'string') {
    errors.push(`${prefix}.keyword: 如果提供，必须为字符串，当前值=${JSON.stringify(emp.keyword)}`);
  }

  return errors;
}

/**
 * 校验完整的 AnimationPlan
 * @param {object} plan
 * @returns {{ valid: boolean, errors: string[], sanitized: object | null }}
 */
function validateAnimationPlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') {
    errors.push('plan 必须是对象');
    return { valid: false, errors, sanitized: null };
  }

  // mediaId
  if (typeof plan.mediaId !== 'string' || !plan.mediaId.trim()) {
    errors.push('mediaId: 必须为非空字符串');
  }

  // duration
  if (typeof plan.duration !== 'number' || plan.duration <= 0) {
    errors.push(`duration: 必须为正数，当前值=${plan.duration}`);
  }

  // imageSize
  if (!plan.imageSize || typeof plan.imageSize !== 'object') {
    errors.push('imageSize: 必须是 { w, h } 对象');
  } else {
    if (typeof plan.imageSize.w !== 'number' || plan.imageSize.w <= 0) {
      errors.push(`imageSize.w: 必须为正数，当前值=${plan.imageSize.w}`);
    }
    if (typeof plan.imageSize.h !== 'number' || plan.imageSize.h <= 0) {
      errors.push(`imageSize.h: 必须为正数，当前值=${plan.imageSize.h}`);
    }
  }

  // emphases
  if (!Array.isArray(plan.emphases)) {
    errors.push('emphases: 必须是数组');
  } else if (plan.emphases.length > 0) {
    for (let i = 0; i < plan.emphases.length; i++) {
      errors.push(...validateEmphasis(plan.emphases[i], i));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? sanitizeAnimationPlan(plan) : null,
  };
}

/**
 * 清洗 AnimationPlan，修复边界问题
 * @param {object} plan
 * @returns {object} 清洗后的 plan（新对象，不修改输入）
 */
function sanitizeAnimationPlan(plan) {
  const sanitized = {
    mediaId: String(plan.mediaId || '').trim(),
    duration: Math.max(0, Number(plan.duration) || 0),
    imageSize: {
      w: Math.max(1, Math.round(Number(plan.imageSize?.w) || 0)),
      h: Math.max(1, Math.round(Number(plan.imageSize?.h) || 0)),
    },
    emphases: [],
    meta: plan.meta ? { ...plan.meta } : undefined,
  };

  if (Array.isArray(plan.emphases)) {
    // 筛选有效 emphasis，截断到 MAX_EMPHASES
    const valid = plan.emphases
      .filter(emp => emp && typeof emp === 'object')
      .filter(emp => typeof emp.start === 'number' && typeof emp.end === 'number' && emp.start < emp.end)
      .slice(0, MAX_EMPHASES);

    sanitized.emphases = valid.map((emp, i) => ({
      order: i + 1, // 重建 order
      start: Number(emp.start),
      end: Number(emp.end),
      kind: VALID_EMPHASIS_KINDS.has(emp.kind) ? emp.kind : 'text',
      bboxNorm: clampBbox(emp.bboxNorm || [0, 0, 1, 1]),
      confidence: Math.max(0, Math.min(1, Number(emp.confidence) || 0.5)),
      type: VALID_EMPHASIS_TYPES.has(emp.type) ? emp.type : 'glow-pulse',
      keyword: typeof emp.keyword === 'string' ? emp.keyword.slice(0, 40) : undefined,
      scriptSlice: typeof emp.scriptSlice === 'string' ? emp.scriptSlice.slice(0, 200) : undefined,
    }));
  }

  return sanitized;
}

/**
 * Clamp bbox 到 [0,1] 范围
 */
function clampBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return [0, 0, 1, 1];
  }
  let [x, y, w, h] = bbox.map(Number);
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0, Math.min(1 - x, w));
  h = Math.max(0, Math.min(1 - y, h));
  return [x, y, w, h];
}

/**
 * 降级 plan：当 OCR/VLM/LLM 均失败时，优先用 sentenceAnchors 生成底端字幕 emphases；
 * 若未提供 sentenceAnchors，则返回空数组（向后兼容）。
 * @param {{
 *   mediaId: string,
 *   duration: number,
 *   imageSize: { w: number, h: number },
 *   scriptText: string,
 *   sentenceAnchors?: Array<{ index?: number, text: string, startSec: number, endSec: number }>
 * }} input
 * @returns {object} 降级 AnimationPlan（含字幕 或 空数组）
 */
function createFallbackPlan(input) {
  const duration = Math.max(1, Number(input.duration) || 10);
  const anchors = Array.isArray(input.sentenceAnchors) ? input.sentenceAnchors : [];

  let emphases = [];
  if (anchors.length) {
    emphases = anchors
      .map((a, i) => {
        const start = Math.max(0, Number(a.startSec) || 0);
        const endRaw = Number(a.endSec);
        const end = Math.min(duration, Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 1.5);
        if (end <= start) return null;
        const text = String(a.text || '').trim();
        if (!text) return null;
        return {
          order: i + 1,
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          kind: 'subtitle',
          bboxNorm: [...SUBTITLE_BBOX_NORM],
          confidence: 1,
          type: 'subtitle',
          scriptSlice: text.slice(0, 80),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_EMPHASES);
  }

  return {
    mediaId: String(input.mediaId || ''),
    duration,
    imageSize: {
      w: Math.max(1, Number(input.imageSize?.w) || 1920),
      h: Math.max(1, Number(input.imageSize?.h) || 1080),
    },
    emphases,
    meta: {
      ocrLines: 0,
      vlmBlocks: 0,
      aggModel: 'fallback',
      elapsedMs: 0,
      fallback: true,
      subtitleCount: emphases.length,
    },
  };
}

module.exports = {
  validateAnimationPlan,
  sanitizeAnimationPlan,
  validateEmphasis,
  createFallbackPlan,
  clampBbox,
  VALID_EMPHASIS_KINDS,
  VALID_EMPHASIS_TYPES,
  SUBTITLE_BBOX_NORM,
  MAX_EMPHASES,
};
