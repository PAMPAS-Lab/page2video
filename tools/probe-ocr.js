#!/usr/bin/env node

/**
 * probe-ocr.js — OCR 选型验证
 * 
 * 用法：node tools/probe-ocr.js <path-to-png> [--save-images]
 * 
 * 调用 DashScope Qwen-VL-Max 进行 OCR，输出：
 *   - 每行文字 + bbox + confidence（归一化到 [0,1]）
 *   - 两轮对比：结构化 OCR prompt vs 自然语言 OCR prompt
 *   - 比较识别完整度、bbox 偏差、耗时
 */

const fs = require('fs');
const path = require('path');
require('./lib/envLoader');

// ── helpers ──────────────────────────────────────────────

function imageToBase64DataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${b64}`;
}

async function callDashScope(model, messages, temperature = 0.1, timeoutMsParam) {
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
  // 尝试直接解析
  try { return JSON.parse(content); } catch (_) {}
  // 尝试提取 ```json ... ``` 块
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  // 尝试提取第一个 { 到最后一个 }
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }
  return null;
}

function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // PNG: IHDR 在偏移 16 处，宽高各 4 字节 big-endian
    if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { w, h };
    }
    // JPEG: 需要解析 SOF marker，这里简化处理
    return { w: 0, h: 0 };
  } catch (_) {
    return { w: 0, h: 0 };
  }
}

// ── OCR prompts ──────────────────────────────────────────

function buildStructuredOcrMessages(imageDataUri) {
  return [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUri } },
        {
          type: 'text',
          text: [
            '你是一个精确的 OCR 文字识别模型。请仔细识别图片中所有可见的文字行，输出严格 JSON。',
            '',
            '要求：',
            '1. 逐行输出，每行包含：text（原文）、bboxNorm（归一化边界框 [x, y, w, h]，值域 [0,1]）、confidence（0-1 自评置信度）',
            '2. bboxNorm 的 x,y 是左上角坐标，w,h 是宽高，均相对于图片宽高归一化',
            '3. 按从上到下、从左到右的顺序排列',
            '4. 只输出文字，不要描述图表、图像等非文字内容',
            '5. 不要遗漏任何可见文字，包括小字、标注、页眉页脚',
            '',
            '输出 JSON 格式：',
            '{',
            '  "imageSize": { "w": 1920, "h": 1080 },',
            '  "lines": [',
            '    { "text": "识别到的文字", "bboxNorm": [0.1, 0.05, 0.8, 0.04], "confidence": 0.95 }',
            '  ]',
            '}',
          ].join('\n'),
        },
      ],
    },
  ];
}

function buildNaturalOcrMessages(imageDataUri) {
  return [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUri } },
        {
          type: 'text',
          text: [
            '请仔细查看这张幻灯片截图，识别其中所有的文字内容及其位置。',
            '',
            '请输出 JSON，格式如下：',
            '{',
            '  "imageSize": { "w": 1920, "h": 1080 },',
            '  "lines": [',
            '    { "text": "文字内容", "bboxNorm": [x, y, w, h], "confidence": 0.9 }',
            '  ]',
            '}',
            '',
            'bboxNorm 为归一化坐标，x,y,w,h 均在 [0,1] 范围内。请确保 bbox 准确包围文字区域。',
          ].join('\n'),
        },
      ],
    },
  ];
}

// ── main ─────────────────────────────────────────────────

async function main() {
  const pngPath = process.argv[2];
  if (!pngPath) {
    console.error('用法：node tools/probe-ocr.js <path-to-png> [--save-images]');
    process.exit(1);
  }

  const absPath = path.resolve(pngPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在：${absPath}`);
    process.exit(1);
  }

  const imageSize = getImageSize(absPath);
  console.log(`\n📷 图片：${absPath}`);
  console.log(`   尺寸：${imageSize.w} × ${imageSize.h}\n`);

  const imageDataUri = imageToBase64DataUri(absPath);
  const model = process.env.EMPHASIS_VLM_MODEL || 'qwen3.6-flash';

  // ── 方案 1：结构化 OCR prompt ──
  console.log('━'.repeat(60));
  console.log(`方案 1：结构化 OCR prompt（${model} + 严格 JSON 输出）`);
  console.log('━'.repeat(60));

  const t1Start = Date.now();
  let result1 = null;
  let error1 = null;
  try {
    const { content } = await callDashScope(model, buildStructuredOcrMessages(imageDataUri), 0.1);
    result1 = parseJsonContent(content);
    if (!result1) {
      error1 = `JSON 解析失败，原始输出（前500字符）：\n${content.slice(0, 500)}`;
    }
  } catch (err) {
    error1 = err.message;
  }
  const t1Ms = Date.now() - t1Start;

  if (error1) {
    console.log(`❌ 失败 (${t1Ms}ms): ${error1}\n`);
  } else {
    const lines1 = result1.lines || [];
    const confs1 = lines1.map(l => l.confidence || 0);
    const minConf1 = confs1.length ? Math.min(...confs1).toFixed(2) : 'N/A';
    const maxConf1 = confs1.length ? Math.max(...confs1).toFixed(2) : 'N/A';
    console.log(`✅ 成功 (${t1Ms}ms)`);
    console.log(`   识别行数：${lines1.length}`);
    console.log(`   置信度范围：${minConf1} ~ ${maxConf1}`);
    console.log(`   文字行预览：`);
    for (const line of lines1.slice(0, 10)) {
      console.log(`     [${(line.confidence || 0).toFixed(2)}] ${line.text?.slice(0, 60)}${(line.text || '').length > 60 ? '...' : ''}  bbox=${JSON.stringify(line.bboxNorm)}`);
    }
    if (lines1.length > 10) console.log(`     ... 共 ${lines1.length} 行`);
    console.log('');
  }

  // ── 方案 2：自然语言 OCR prompt ──
  console.log('━'.repeat(60));
  console.log(`方案 2：自然语言 OCR prompt（${model} + 宽松 JSON）`);
  console.log('━'.repeat(60));

  const t2Start = Date.now();
  let result2 = null;
  let error2 = null;
  try {
    const { content } = await callDashScope(model, buildNaturalOcrMessages(imageDataUri), 0.1);
    result2 = parseJsonContent(content);
    if (!result2) {
      error2 = `JSON 解析失败，原始输出（前500字符）：\n${content.slice(0, 500)}`;
    }
  } catch (err) {
    error2 = err.message;
  }
  const t2Ms = Date.now() - t2Start;

  if (error2) {
    console.log(`❌ 失败 (${t2Ms}ms): ${error2}\n`);
  } else {
    const lines2 = result2.lines || [];
    const confs2 = lines2.map(l => l.confidence || 0);
    const minConf2 = confs2.length ? Math.min(...confs2).toFixed(2) : 'N/A';
    const maxConf2 = confs2.length ? Math.max(...confs2).toFixed(2) : 'N/A';
    console.log(`✅ 成功 (${t2Ms}ms)`);
    console.log(`   识别行数：${lines2.length}`);
    console.log(`   置信度范围：${minConf2} ~ ${maxConf2}`);
    console.log(`   文字行预览：`);
    for (const line of lines2.slice(0, 10)) {
      console.log(`     [${(line.confidence || 0).toFixed(2)}] ${line.text?.slice(0, 60)}${(line.text || '').length > 60 ? '...' : ''}  bbox=${JSON.stringify(line.bboxNorm)}`);
    }
    if (lines2.length > 10) console.log(`     ... 共 ${lines2.length} 行`);
    console.log('');
  }

  // ── 对比总结 ──
  console.log('═'.repeat(60));
  console.log('对比总结');
  console.log('═'.repeat(60));

  const finalLines1 = result1?.lines || [];
  const finalLines2 = result2?.lines || [];
  const avgConf1 = finalLines1.length ? (finalLines1.reduce((s,l) => s + (l.confidence||0), 0) / finalLines1.length).toFixed(3) : 'N/A';
  const avgConf2 = finalLines2.length ? (finalLines2.reduce((s,l) => s + (l.confidence||0), 0) / finalLines2.length).toFixed(3) : 'N/A';

  console.log(`| 指标           | 方案1（结构化） | 方案2（自然语言） |`);
  console.log(`|----------------|----------------|-------------------|`);
  console.log(`| 耗时           | ${t1Ms}ms       | ${t2Ms}ms          |`);
  console.log(`| 识别行数       | ${finalLines1.length}            | ${finalLines2.length}               |`);
  console.log(`| JSON 解析      | ${result1 ? '✅' : '❌'}            | ${result2 ? '✅' : '❌'}               |`);
  console.log(`| 平均置信度     | ${avgConf1}        | ${avgConf2}           |`);

  // 保存结果
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `${ts}-ocr-probe.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    imagePath: absPath,
    imageSize,
    model,
    results: {
      structured: { ok: !error1, elapsedMs: t1Ms, error: error1, data: result1 },
      natural: { ok: !error2, elapsedMs: t2Ms, error: error2, data: result2 },
    },
    comparison: {
      linesStructured: finalLines1.length,
      linesNatural: finalLines2.length,
      avgConfStructured: finalLines1.length ? finalLines1.reduce((s,l) => s + (l.confidence||0), 0) / finalLines1.length : 0,
      avgConfNatural: finalLines2.length ? finalLines2.reduce((s,l) => s + (l.confidence||0), 0) / finalLines2.length : 0,
      recommendation: (finalLines1.length >= finalLines2.length && result1) ? 'structured' : (result2 ? 'natural' : 'none'),
    },
  }, null, 2), 'utf-8');

  console.log(`\n📄 完整结果已保存到：${outPath}`);
  console.log(`\n🎯 推荐：${finalLines1.length >= finalLines2.length && result1 ? '方案1（结构化 OCR prompt）— 识别行数更多，JSON 更稳定' : result2 ? '方案2（自然语言 OCR prompt）— 输出质量更好' : '两个方案均失败，需进一步调试'}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
