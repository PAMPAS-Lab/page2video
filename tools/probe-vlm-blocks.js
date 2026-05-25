#!/usr/bin/env node

/**
 * probe-vlm-blocks.js — VLM 区块识别 Prompt 调教
 * 
 * 用法：node tools/probe-vlm-blocks.js <path-to-png> [--save-images]
 * 
 * 调用 Qwen-VL-Max + vlmBlockDetect.txt prompt，
 * 识别幻灯片中非文字视觉区块（图表、插图、表格、公式等）。
 * 输出标准化 JSON 供目测验证和 prompt 迭代。
 */

const fs = require('fs');
const path = require('path');
require('./lib/envLoader');
const { normalizeVlmResult, QWEN_CANVAS } = require('../src/lib/qwenBbox');

// ── helpers ──────────────────────────────────────────────

function imageToBase64DataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${b64}`;
}

async function callDashScope(model, messages, temperature = 0.2, timeoutMsParam) {
  const timeoutMs = timeoutMsParam || Number(process.env.EMPHASIS_TASK_TIMEOUT_MS) || 60000;
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY 未设置，请在 .env 中配置');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, temperature, messages }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return { content, usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonContent(content) {
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

function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { w, h };
    }
    return { w: 0, h: 0 };
  } catch (_) {
    return { w: 0, h: 0 };
  }
}

// ── main ─────────────────────────────────────────────────

async function main() {
  const pngPath = process.argv[2];
  if (!pngPath) {
    console.error('用法：node tools/probe-vlm-blocks.js <path-to-png> [--save-images]');
    process.exit(1);
  }

  const absPath = path.resolve(pngPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在：${absPath}`);
    process.exit(1);
  }

  // 加载 VLM block detect prompt
  const promptPath = path.join(__dirname, '..', 'config', 'prompts', 'vlmBlockDetect.txt');
  if (!fs.existsSync(promptPath)) {
    console.error(`Prompt 文件不存在：${promptPath}`);
    process.exit(1);
  }
  const blockDetectPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
  if (!blockDetectPrompt) {
    console.error('Prompt 文件为空');
    process.exit(1);
  }

  const imageSize = getImageSize(absPath);
  console.log(`\n📷 图片：${absPath}`);
  console.log(`   尺寸：${imageSize.w} × ${imageSize.h}`);
  console.log(`   Prompt：vlmBlockDetect.txt（${blockDetectPrompt.length} 字符）\n`);

  const imageDataUri = imageToBase64DataUri(absPath);
  const model = process.env.EMPHASIS_VLM_MODEL || 'qwen3.6-flash';

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUri } },
        { type: 'text', text: blockDetectPrompt },
      ],
    },
  ];

  console.log('━'.repeat(60));
  console.log(`调用 ${model} 进行非文字视觉区块识别...`);
  console.log('━'.repeat(60));

  const tStart = Date.now();
  let result = null;
  let error = null;
  let rawContent = '';

  let rawResult = null; // 模型原始解析结果（保留 bbox_2d 等原字段）
  try {
    const { content } = await callDashScope(model, messages, 0.2);
    rawContent = content;
    rawResult = parseJsonContent(content);
    if (!rawResult) {
      error = `JSON 解析失败，原始输出：\n${content.slice(0, 500)}`;
    } else {
      // 统一坐标规范化：bbox_2d (1000系) → bboxNorm [0,1]
      result = normalizeVlmResult(rawResult);
    }
  } catch (err) {
    error = err.message;
  }
  const elapsedMs = Date.now() - tStart;

  if (error) {
    console.log(`❌ 失败 (${elapsedMs}ms): ${error}\n`);
  } else {
    const blocks = result.blocks || [];
    const declared = result._declaredImageSize;
    const declaredStr = declared ? `${declared.w}×${declared.h}` : '未填';
    // 检测 bbox_2d 实际数值范围，诊断模型实际使用的坐标系
    const allCoords = blocks.flatMap(b => Array.isArray(b._bboxRaw && b._bboxRaw.value) ? b._bboxRaw.value : []);
    const maxCoord = allCoords.length ? Math.max(...allCoords) : 0;
    console.log(`✅ 成功 (${elapsedMs}ms)`);
    console.log(`   识别区块数：${blocks.length}`);
    console.log(`   模型自报 imageSize：${declaredStr}（仅诊断）`);
    console.log(`   强制画布：1000×1000（Qwen-VL Grounding 官方标准）`);
    console.log(`   bbox_2d 实测最大值：${maxCoord}${maxCoord > 1010 ? ' ⚠超出 1000 画布' : ''}`);
    console.log(`   区块详情：`);
    for (const block of blocks) {
      const raw = block._bboxRaw ? JSON.stringify(block._bboxRaw.value) : '(none)';
      const flags = [
        block._bboxOverflow ? '⚠越界' : '',
        block._bboxSwapped ? '⚠角点颠倒' : '',
        block._bboxIssue ? `⚠${block._bboxIssue}` : '',
        block._bboxNote ? `ℹ${block._bboxNote}` : '',
      ].filter(Boolean).join(' ');
      console.log(`     [${block.id}] ${block.kind} | conf=${block.confidence} | "${block.description}" ${flags}`);
      console.log(`          raw=${raw}`);
      console.log(`          bboxNorm=${JSON.stringify(block.bboxNorm.map(v => Number(v.toFixed(3))))}`);
    }
    console.log('');

    // 自检
    console.log('━'.repeat(60));
    console.log('自检清单');
    console.log('━'.repeat(60));
    const overflowCount = blocks.filter(b => b._bboxOverflow).length;
    const declaredMatches1000 = declared && declared.w === 1000 && declared.h === 1000;
    const checks = [
      { label: 'JSON 输出合法', pass: !!result },
      { label: 'blocks 数量 ≤ 5', pass: blocks.length <= 5 },
      { label: '每个 block 含 id', pass: blocks.every(b => !!b.id) },
      { label: 'kind 为有效枚举值', pass: blocks.every(b => ['image', 'chart', 'table', 'formula', 'diagram', 'other'].includes(b.kind)) },
      { label: '使用了 bbox_2d 字段', pass: blocks.every(b => b._bboxRaw && b._bboxRaw.source === 'bbox_2d') },
      { label: `模型自报 imageSize 为 1000×1000（遵守 prompt）`, pass: !!declaredMatches1000 },
      { label: `原始 bbox_2d 在 [0,1000] 内（越界 ${overflowCount}/${blocks.length}）`, pass: overflowCount === 0 },
      { label: '归一化 bboxNorm 在 [0,1] 内', pass: blocks.every(b => {
        const [x, y, w, h] = b.bboxNorm || [];
        return [x, y, w, h, x + w, y + h].every(v => v >= 0 && v <= 1.001);
      })},
      { label: 'confidence 在 [0,1] 内', pass: blocks.every(b => b.confidence >= 0 && b.confidence <= 1) },
      { label: 'description 非空', pass: blocks.every(b => !!(b.description && b.description.trim())) },
    ];
    for (const check of checks) {
      console.log(`   ${check.pass ? '✅' : '❌'} ${check.label}`);
    }
  }

  // 保存结果
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `${ts}-vlm-blocks.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    imagePath: absPath,
    imageSize,
    model,
    promptFile: 'vlmBlockDetect.txt',
    coordinateSystem: 'qwen-bbox_2d-1000',
    ok: !error,
    elapsedMs,
    error: error || null,
    rawContent: rawContent.slice(0, 2000),
    rawResult,         // 模型原始 JSON（含 bbox_2d）
    result,            // 规范化后（含 bboxNorm）
  }, null, 2), 'utf-8');

  console.log(`\n📄 完整结果已保存到：${outPath}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
