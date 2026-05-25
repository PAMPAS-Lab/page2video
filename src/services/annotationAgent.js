/**
 * annotationAgent.js — 强调动画 Agent 主流程
 *
 * 输入 EmphasisTaskInput → OCR/VLM 并行采集 → 聚合 LLM → 校验 → 输出 AnimationPlan
 *
 * 设计原则：
 *   - LLM 只做"选择 + 排序 + 定时"，输出候选 id；bbox 由本地根据 id 回查
 *   - 任一环节失败均退化为合法 plan（最终走 createFallbackPlan）
 *   - 全程零新依赖，DashScope 走 OpenAI 兼容协议
 *
 * 导出：
 *   generatePlan(input: EmphasisTaskInput) → Promise<AnimationPlan>
 *   buildAggregationPrompt(input, candidateList)（导出便于测试）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { runOcrRaw } = require('./ocr');
const { detectBlocks } = require('./vlm');
const {
  validateAnimationPlan,
  sanitizeAnimationPlan,
  createFallbackPlan,
  clampBbox,
} = require('./planSchema');
const {
  processOcrLines,
  DEFAULT_AREA_THRESHOLD,
} = require('../lib/ocrAggregate');
const config = require('../config');

const AGENT_NAME = 'annotation-agent';
const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OCR_TO_LLM = 30;
const MAX_VLM_TO_LLM = 6;

let cachedPrompt = null;
function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(config.getPromptsDir(), 'emphasisAnnotation.txt');
  if (!fs.existsSync(promptPath)) {
    throw new Error(`emphasisAnnotation.txt 不存在：${promptPath}`);
  }
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
  if (!cachedPrompt) throw new Error('emphasisAnnotation.txt 为空');
  return cachedPrompt;
}

// ── 工具 ────────────────────────────────────────────────

function safeNumber(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseJsonContent(content) {
  if (!content) return null;
  try { return JSON.parse(content); } catch (_) {}
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }
  return null;
}

async function callAggLlm({ model, prompt, timeoutMs }) {
  const apiKey = config.getDashScopeApiKey();
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const _t0 = Date.now();
  console.log(`[agg] → model=${model} | chars=${prompt.length}`);
  try {
    const res = await fetch(DASHSCOPE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你只输出严格 JSON，不要包含任何解释或 Markdown 标记。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const _result = {
      content: data?.choices?.[0]?.message?.content || '',
      usage: data?.usage || null,
    };
    console.log(`[agg] ← ${((Date.now() - _t0) / 1000).toFixed(1)}s | in=${data?.usage?.input_tokens ?? data?.usage?.prompt_tokens ?? '?'} out=${data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? '?'} tokens`);
    return _result;
  } finally {
    clearTimeout(timer);
  }
}

// ── 候选构建（生成带 id 的列表 + 回查 map）────────────────

function buildCandidates(ocrKeptLines, vlmBlocks) {
  const candidateList = [];
  const candidateMap = {};

  const textLines = (ocrKeptLines || [])
    .filter(l => l && Array.isArray(l.bboxNorm) && (l.text || '').trim())
    .slice(0, MAX_OCR_TO_LLM);

  textLines.forEach((l, i) => {
    const id = `t${i + 1}`;
    const bbox = clampBbox(l.bboxNorm);
    const confidence = typeof l.confidence === 'number' ? Number(l.confidence.toFixed(3)) : 0.9;
    candidateList.push({
      id,
      kind: 'text',
      content: String(l.text).slice(0, 80),
      confidence,
    });
    candidateMap[id] = { kind: 'text', bboxNorm: bbox, confidence, text: String(l.text).slice(0, 80) };
  });

  const blocks = (vlmBlocks || [])
    .filter(b => b && Array.isArray(b.bboxNorm))
    .slice(0, MAX_VLM_TO_LLM);

  blocks.forEach((b, i) => {
    const id = b.id || `v${i + 1}`;
    const bbox = clampBbox(b.bboxNorm);
    const confidence = typeof b.confidence === 'number' ? Number(b.confidence.toFixed(3)) : 0.5;
    candidateList.push({
      id,
      kind: 'block',
      content: String(b.description || '').slice(0, 60),
      confidence,
    });
    candidateMap[id] = { kind: 'block', bboxNorm: bbox, confidence, description: String(b.description || '').slice(0, 60) };
  });

  return { candidateList, candidateMap };
}

// ── 构造 prompt（不含 bbox，只有 id + content）───────────

function buildAggregationPrompt(input, candidateList) {
  const { script, duration, sentenceAnchors, asrSource } = input;
  const asrRefined = asrSource && asrSource !== 'char-ratio';
  const anchors = Array.isArray(sentenceAnchors)
    ? sentenceAnchors
        .filter(a => a && Number.isFinite(Number(a.startSec)))
        .map((a, i) => ({
          index: typeof a.index === 'number' ? a.index : i,
          startSec: Number(Number(a.startSec).toFixed(2)),
          endSec: Number.isFinite(Number(a.endSec)) ? Number(Number(a.endSec).toFixed(2)) : undefined,
          text: String(a.text || '').slice(0, 60),
        }))
    : [];
  const payload = {
    script: String(script || '').slice(0, 4000),
    duration: Number(duration) || 0,
    candidates: candidateList,
    sentenceAnchors: anchors,
    anchorPrecision: asrRefined ? 'asr' : 'char-ratio',
  };
  const promptHeader = loadPrompt();
  return `${promptHeader}\n\n## 当前任务输入\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

// ── 后处理：LLM 输出 id → 本地回查 bbox → 组装合法 plan ───

function postProcessLlmPlan({ llmJson, input, candidateMap, ocrImageSize, vlmImageSize, meta, sentenceAnchors, asrSource }) {
  const safeImageSize = {
    w: safeNumber(ocrImageSize?.w || vlmImageSize?.w, 1920),
    h: safeNumber(ocrImageSize?.h || vlmImageSize?.h, 1080),
  };
  const duration = Math.max(1, Number(input.duration) || 0);

  const asrRefined = asrSource && asrSource !== 'char-ratio';
  const SNAP_THRESHOLD = asrRefined ? 0.8 : 2.0;
  const SNAP_OFFSET = asrRefined ? 0 : 0.1;

  const anchorList = Array.isArray(sentenceAnchors)
    ? sentenceAnchors
        .filter(a => a && Number.isFinite(Number(a.startSec)) && Number(a.startSec) >= 0)
        .map(a => ({ startSec: Number(a.startSec), endSec: Number(a.endSec) || 0 }))
    : [];
  function snapToAnchor(t) {
    if (!anchorList.length) return { start: t, end: null };
    let best = null;
    let bestDist = Infinity;
    for (const a of anchorList) {
      const d = Math.abs(a.startSec - t);
      if (d < bestDist) { bestDist = d; best = a; }
    }
    if (best != null && bestDist <= SNAP_THRESHOLD) {
      return {
        start: Math.max(0, best.startSec + SNAP_OFFSET),
        end: best.endSec > best.startSec ? best.endSec : null,
      };
    }
    return { start: t, end: null };
  }

  let emphases = Array.isArray(llmJson?.emphases) ? llmJson.emphases : [];

  emphases = emphases
    .filter(e => e && typeof e === 'object')
    .map((e, i) => {
      const id = String(e.id || '').trim();
      let start = Math.max(0, safeNumber(e.start, 0));
      const snapped = snapToAnchor(start);
      start = snapped.start;
      let end = Math.min(duration, safeNumber(e.end, start + 2));

      if (snapped.end && asrRefined) {
        const anchorDuration = snapped.end - snapped.start;
        end = Math.min(duration, snapped.start + Math.max(2.0, Math.min(3.5, anchorDuration)));
      }

      if (end - start < 0.3) end = Math.min(duration, start + 1.5);

      const candidate = candidateMap[id];
      let kind, type, bbox, confidence;

      if (id === '_chip' || !candidate) {
        return null;
      } else {
        kind = candidate.kind;
        bbox = candidate.bboxNorm;
        confidence = candidate.confidence;
        type = kind === 'block' ? 'glow-pulse' : 'text-highlight';
      }

      return {
        order: i + 1,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        kind,
        bboxNorm: bbox,
        confidence,
        type,
        keyword: typeof e.keyword === 'string' ? e.keyword.trim().slice(0, 16) : undefined,
        scriptSlice: typeof e.scriptSlice === 'string' ? e.scriptSlice.slice(0, 200) : undefined,
      };
    })
    .filter(e => e !== null && e.end > e.start)
    .sort((a, b) => a.start - b.start)
    .slice(0, 5);

  for (let i = 1; i < emphases.length; i++) {
    const prev = emphases[i - 1];
    const cur = emphases[i];
    if (cur.start < prev.end + 0.4) {
      cur.start = Math.min(duration - 0.5, prev.end + 0.4);
      if (cur.end <= cur.start) cur.end = Math.min(duration, cur.start + 1.5);
    }
  }

  emphases = emphases.map((e, i) => ({ ...e, order: i + 1 }));

  const plan = {
    mediaId: String(input.mediaId || ''),
    duration,
    imageSize: safeImageSize,
    emphases,
    meta: {
      ocrLines: meta.ocrLines,
      vlmBlocks: meta.vlmBlocks,
      aggModel: meta.aggModel,
      elapsedMs: meta.elapsedMs,
      ocrSource: meta.ocrSource,
      ocrFailed: meta.ocrFailed,
      vlmFailed: meta.vlmFailed,
      llmFailed: meta.llmFailed,
    },
  };

  const v = validateAnimationPlan(plan);
  if (v.valid) return v.sanitized;
  const sanitized = sanitizeAnimationPlan(plan);
  const v2 = validateAnimationPlan(sanitized);
  if (v2.valid) {
    sanitized.meta = plan.meta;
    return sanitized;
  }
  return null;
}

// ── 主入口 ─────────────────────────────────────────────

/**
 * 生成 AnimationPlan
 * @param {{ mediaId, sectionId?, imagePath, scriptText, duration, language?, sentenceAnchors?, asrSource? }} input
 * @returns {Promise<AnimationPlan>}
 */
async function generatePlan(input) {
  const tStart = Date.now();
  const errors = { ocr: null, vlm: null, llm: null };

  if (!input || !input.mediaId) {
    throw new Error(`${AGENT_NAME}: 缺少 mediaId`);
  }
  if (!input.imagePath || !fs.existsSync(input.imagePath)) {
    throw new Error(`${AGENT_NAME}: 缩略图不存在 ${input.imagePath}`);
  }
  const duration = Number(input.duration);
  if (!Number.isFinite(duration) || duration < 3) {
    return createFallbackPlan({
      mediaId: input.mediaId,
      duration: Math.max(3, duration || 3),
      imageSize: { w: 1920, h: 1080 },
      scriptText: input.scriptText || '',
      sentenceAnchors: input.sentenceAnchors,
    });
  }
  if (!input.scriptText || !String(input.scriptText).trim()) {
    return createFallbackPlan({
      mediaId: input.mediaId,
      duration,
      imageSize: { w: 1920, h: 1080 },
      scriptText: '',
      sentenceAnchors: input.sentenceAnchors,
    });
  }

  const timeoutMs = config.getTaskTimeoutMs();
  const aggModel = config.getAggModel();
  const areaThreshold = config.getOcrAreaThreshold();
  const ocrMode = config.getOcrMode();

  // 1. OCR + VLM 并行
  const [ocrResult, vlmResult] = await Promise.all([
    runOcrRaw(input.imagePath, { timeoutMs }).catch(err => {
      errors.ocr = err;
      return null;
    }),
    detectBlocks(input.imagePath, { timeoutMs }).catch(err => {
      errors.vlm = err;
      return null;
    }),
  ]);

  const vlmBlocks = vlmResult?.blocks || [];
  const ocrRawLines = ocrResult?.rawLines || [];

  // 2. OCR 后处理
  let processed = { kept: [], stats: { inputCount: 0, finalCount: 0 } };
  if (ocrRawLines.length) {
    processed = processOcrLines(ocrRawLines, vlmBlocks, {
      mode: ocrMode,
      areaThreshold,
    });
  }

  // 3. 构建候选列表 + 回查 map
  const { candidateList, candidateMap } = buildCandidates(processed.kept, vlmBlocks);

  const ocrImageSize = ocrResult?.imageSize || null;
  const vlmImageSize = vlmResult?.imageSize || null;
  const planInput = {
    mediaId: input.mediaId,
    duration,
    imageSize: ocrImageSize || vlmImageSize || { w: 1920, h: 1080 },
    scriptText: input.scriptText,
  };

  // 4. 聚合 LLM
  let llmJson = null;
  if (candidateList.length) {
    const prompt = buildAggregationPrompt(
      { script: input.scriptText, duration, sentenceAnchors: input.sentenceAnchors, asrSource: input.asrSource },
      candidateList,
    );
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { content } = await callAggLlm({ model: aggModel, prompt, timeoutMs });
        console.log(`[agent] LLM raw content (first 400 chars): ${String(content).slice(0, 400)}`);
        const parsed = parseJsonContent(content);
        if (!parsed) throw new Error(`聚合 LLM 输出无法解析：${content.slice(0, 200)}`);
        llmJson = parsed;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!llmJson) errors.llm = lastErr;
  }

  const meta = {
    ocrLines: candidateList.filter(c => c.kind === 'text').length,
    vlmBlocks: candidateList.filter(c => c.kind === 'block').length,
    aggModel,
    elapsedMs: Date.now() - tStart,
    ocrSource: ocrResult?.source || (errors.ocr ? `failed:${errors.ocr.message}` : 'empty'),
    ocrFailed: !!errors.ocr,
    vlmFailed: !!errors.vlm,
    llmFailed: !!errors.llm,
  };

  // 5. 后处理 LLM 输出
  if (llmJson) {
    const llmIds = Array.isArray(llmJson.emphases) ? llmJson.emphases.map(e => e?.id) : [];
    const mapKeys = Object.keys(candidateMap);
    console.log(`[agent] LLM returned ${llmIds.length} emphases, ids=[${llmIds.join(',')}] | candidateMap keys=[${mapKeys.join(',')}]`);
    const plan = postProcessLlmPlan({
      llmJson,
      input: planInput,
      candidateMap,
      ocrImageSize,
      vlmImageSize,
      meta,
      sentenceAnchors: input.sentenceAnchors,
      asrSource: input.asrSource,
    });
    console.log(`[agent] postProcess result: ${plan?.emphases?.length ?? 0} emphases survived`);
    if (plan && plan.emphases && plan.emphases.length) {
      return plan;
    }
  }

  // 6. 兜底
  const fallback = createFallbackPlan({
    mediaId: input.mediaId,
    duration,
    imageSize: ocrImageSize || vlmImageSize || { w: 1920, h: 1080 },
    scriptText: input.scriptText,
    sentenceAnchors: input.sentenceAnchors,
  });
  fallback.meta = {
    ...(fallback.meta || {}),
    ocrLines: meta.ocrLines,
    vlmBlocks: meta.vlmBlocks,
    aggModel: meta.aggModel,
    elapsedMs: meta.elapsedMs,
    ocrFailed: meta.ocrFailed,
    vlmFailed: meta.vlmFailed,
    llmFailed: meta.llmFailed,
    fallback: true,
    ocrSource: meta.ocrSource,
  };
  return fallback;
}

// ── 检测阶段：仅 OCR + VLM（可独立调用，供前端预览/编辑）────

/**
 * 运行 OCR + VLM 检测，返回结构化结果供前端预览和编辑
 * @param {{ mediaId, imagePath, duration? }} input
 * @returns {Promise<DetectionResult>}
 */
async function runDetection(input) {
  if (!input || !input.mediaId) {
    throw new Error(`${AGENT_NAME}: 缺少 mediaId`);
  }
  if (!input.imagePath || !fs.existsSync(input.imagePath)) {
    throw new Error(`${AGENT_NAME}: 图片不存在 ${input.imagePath}`);
  }

  const timeoutMs = config.getTaskTimeoutMs();
  const areaThreshold = config.getOcrAreaThreshold();
  const ocrMode = config.getOcrMode();
  const errors = { ocr: null, vlm: null };

  const [ocrResult, vlmResult] = await Promise.all([
    runOcrRaw(input.imagePath, { timeoutMs }).catch(err => {
      errors.ocr = err;
      return null;
    }),
    detectBlocks(input.imagePath, { timeoutMs }).catch(err => {
      errors.vlm = err;
      return null;
    }),
  ]);

  const vlmBlocksRaw = vlmResult?.blocks || [];
  const ocrRawLines = ocrResult?.rawLines || [];

  let processed = { kept: [], stats: { inputCount: 0, finalCount: 0 } };
  if (ocrRawLines.length) {
    processed = processOcrLines(ocrRawLines, vlmBlocksRaw, {
      mode: ocrMode,
      areaThreshold,
    });
  }

  return {
    mediaId: String(input.mediaId),
    ocrLines: (processed.kept || []).map(l => ({
      id: l.id || null,
      text: String(l.text || ''),
      bboxNorm: Array.isArray(l.bboxNorm) ? l.bboxNorm.map(Number) : [0, 0, 0, 0],
      confidence: typeof l.confidence === 'number' ? Number(l.confidence.toFixed(3)) : 0.9,
    })),
    vlmBlocks: (vlmBlocksRaw || []).map(b => ({
      id: b.id || null,
      description: String(b.description || ''),
      bboxNorm: Array.isArray(b.bboxNorm) ? b.bboxNorm.map(Number) : [0, 0, 0, 0],
      confidence: typeof b.confidence === 'number' ? Number(b.confidence.toFixed(3)) : 0.5,
      kind: b.kind || 'block',
    })),
    imageSize: ocrResult?.imageSize || vlmResult?.imageSize || { w: 1920, h: 1080 },
    errors: {
      ocrFailed: !!errors.ocr,
      vlmFailed: !!errors.vlm,
      ocrError: errors.ocr ? String(errors.ocr.message) : null,
      vlmError: errors.vlm ? String(errors.vlm.message) : null,
    },
  };
}

/**
 * 基于（可能被用户编辑过的）检测结果生成 AnimationPlan
 * @param {{ mediaId, imagePath, scriptText, duration, sentenceAnchors?, asrSource? }} input
 * @param {{ ocrLines, vlmBlocks, imageSize }} detection - 检测结果（可已被前端修改）
 * @returns {Promise<AnimationPlan>}
 */
async function generatePlanFromDetection(input, detection) {
  const tStart = Date.now();
  const errors = { llm: null };

  if (!input || !input.mediaId) {
    throw new Error(`${AGENT_NAME}: 缺少 mediaId`);
  }

  const duration = Number(input.duration);
  const imageSize = detection?.imageSize || { w: 1920, h: 1080 };

  if (!Number.isFinite(duration) || duration < 3) {
    return createFallbackPlan({
      mediaId: input.mediaId,
      duration: Math.max(3, duration || 3),
      imageSize,
      scriptText: input.scriptText || '',
      sentenceAnchors: input.sentenceAnchors,
    });
  }
  if (!input.scriptText || !String(input.scriptText).trim()) {
    return createFallbackPlan({
      mediaId: input.mediaId,
      duration,
      imageSize,
      scriptText: '',
      sentenceAnchors: input.sentenceAnchors,
    });
  }

  const timeoutMs = config.getTaskTimeoutMs();
  const aggModel = config.getAggModel();

  // 重建候选列表（从可能被编辑过的检测结果）
  const ocrLines = Array.isArray(detection?.ocrLines) ? detection.ocrLines : [];
  const vlmBlocks = Array.isArray(detection?.vlmBlocks) ? detection.vlmBlocks : [];
  const { candidateList, candidateMap } = buildCandidates(ocrLines, vlmBlocks);

  const meta = {
    ocrLines: candidateList.filter(c => c.kind === 'text').length,
    vlmBlocks: candidateList.filter(c => c.kind === 'block').length,
    aggModel,
    elapsedMs: 0,
    ocrSource: 'edited',
    ocrFailed: false,
    vlmFailed: false,
    llmFailed: false,
  };

  // LLM 聚合
  let llmJson = null;
  if (candidateList.length) {
    const prompt = buildAggregationPrompt(
      { script: input.scriptText, duration, sentenceAnchors: input.sentenceAnchors, asrSource: input.asrSource },
      candidateList,
    );
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { content } = await callAggLlm({ model: aggModel, prompt, timeoutMs });
        const parsed = parseJsonContent(content);
        if (!parsed) throw new Error(`聚合 LLM 输出无法解析：${content.slice(0, 200)}`);
        llmJson = parsed;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!llmJson) {
      errors.llm = lastErr;
      meta.llmFailed = true;
    }
  }

  meta.elapsedMs = Date.now() - tStart;

  if (llmJson) {
    const planInput = { mediaId: input.mediaId, duration, imageSize, scriptText: input.scriptText };
    const plan = postProcessLlmPlan({
      llmJson,
      input: planInput,
      candidateMap,
      ocrImageSize: imageSize,
      vlmImageSize: imageSize,
      meta,
      sentenceAnchors: input.sentenceAnchors,
      asrSource: input.asrSource,
    });
    if (plan && plan.emphases && plan.emphases.length) {
      return plan;
    }
  }

  const fallback = createFallbackPlan({
    mediaId: input.mediaId,
    duration,
    imageSize,
    scriptText: input.scriptText,
    sentenceAnchors: input.sentenceAnchors,
  });
  fallback.meta = { ...fallback.meta, ...meta, fallback: true };
  return fallback;
}

module.exports = {
  agentName: AGENT_NAME,
  generatePlan,
  generatePlanFromDetection,
  runDetection,
  buildAggregationPrompt,
};
