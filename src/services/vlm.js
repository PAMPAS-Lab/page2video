/**
 * vlm.js — Qwen-VL 非文字视觉区块识别封装
 *
 * 设计原则：
 *   - 零新依赖（Node 内置 fetch + fs）
 *   - 模型走 EMPHASIS_VLM_MODEL（默认 qwen3.6-flash），通过 DashScope OpenAI 兼容协议
 *   - bbox 由 normalizeVlmResult 统一从 1000 千分位 → bboxNorm[0..1]
 *   - 单次失败重试 1 次，超时由 EMPHASIS_TASK_TIMEOUT_MS 控制
 *
 * 导出：
 *   detectBlocks(imagePath, opts?) → { blocks, imageSize, model, elapsedMs, declaredImageSize }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { normalizeVlmResult } = require('../lib/qwenBbox');
const config = require('../config');

const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60_000;

let cachedPrompt = null;

function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(config.getPromptsDir(), 'vlmBlockDetect.txt');
  if (!fs.existsSync(promptPath)) {
    throw new Error(`vlmBlockDetect.txt 不存在：${promptPath}`);
  }
  const raw = fs.readFileSync(promptPath, 'utf-8').trim();
  if (!raw) throw new Error('vlmBlockDetect.txt 为空');
  cachedPrompt = raw;
  return raw;
}

function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const segLen = buf.readUInt16BE(off + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
        }
        off += 2 + segLen;
      }
    }
  } catch (_) { /* ignore */ }
  return { w: 0, h: 0 };
}

function imageToBase64DataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : (ext || 'png');
  return `data:image/${mime};base64,${buf.toString('base64')}`;
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

async function callDashScope({ model, messages, temperature, timeoutMs }) {
  const apiKey = config.getDashScopeApiKey();
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const _t0 = Date.now();
  console.log(`[vlm] → model=${model}`);
  try {
    const res = await fetch(DASHSCOPE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, temperature, messages }),
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
    console.log(`[vlm] ← ${((Date.now() - _t0) / 1000).toFixed(1)}s | in=${data?.usage?.input_tokens ?? data?.usage?.prompt_tokens ?? '?'} out=${data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? '?'} tokens`);
    return _result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} imagePath 绝对路径
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{blocks, imageSize, model, elapsedMs, declaredImageSize, usage}>}
 */
async function detectBlocks(imagePath, opts = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(`图片不存在：${imagePath}`);
  }
  const tStart = Date.now();
  const imageSize = getImageSize(imagePath);
  const prompt = loadPrompt();
  const model = opts.model || config.getVlmModel();
  const timeoutMs = Number(opts.timeoutMs) || config.getTaskTimeoutMs();
  const dataUri = imageToBase64DataUri(imagePath);

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUri } },
        { type: 'text', text: prompt },
      ],
    },
  ];

  let lastErr = null;
  let parsed = null;
  let usage = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await callDashScope({ model, messages, temperature: 0.2, timeoutMs });
      const obj = parseJsonContent(resp.content);
      if (!obj) throw new Error(`VLM 输出无法解析为 JSON：${resp.content.slice(0, 200)}`);
      parsed = obj;
      usage = resp.usage;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!parsed) {
    throw new Error(`VLM 调用失败：${lastErr?.message || lastErr}`);
  }

  const normalized = normalizeVlmResult(parsed);
  const blocks = (normalized.blocks || [])
    .filter(b => Array.isArray(b.bboxNorm))
    .filter(b => {
      const [, , w, h] = b.bboxNorm;
      return w > 0.001 && h > 0.001;
    })
    .slice(0, 5)
    .map((b, i) => ({
      id: b.id || `v${i + 1}`,
      kind: b.kind || 'other',
      bboxNorm: b.bboxNorm,
      description: typeof b.description === 'string' ? b.description.slice(0, 80) : '',
      confidence: typeof b.confidence === 'number' ? b.confidence : 0.5,
    }));

  return {
    blocks,
    imageSize,
    model,
    elapsedMs: Date.now() - tStart,
    declaredImageSize: normalized._declaredImageSize || null,
    usage,
  };
}

module.exports = {
  detectBlocks,
};
