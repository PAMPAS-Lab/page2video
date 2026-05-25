#!/usr/bin/env node

/**
 * test-asr.js — ASR + 对齐 + 强调动画生成 端到端测试
 *
 * 独立脚本，通过 CLI 参数接收图片、讲稿、音频路径，
 * 运行 ASR → 对齐 → 强调动画生成完整链路，验证效果。
 *
 * 用法：
 *   node tools/test-asr.js --image=<png> --script=<txt> --duration=<sec> [--audio=<audio>] [--skip-asr]
 *
 * 参数说明：
 *   --image      幻灯片截图路径（必需）
 *   --script     讲稿文本文件路径或内联文本（必需）
 *   --duration   视频时长（秒，必需）
 *   --audio      音频文件路径（可选，用于 ASR）
 *   --skip-asr   跳过 ASR，仅使用字符占比估算 sentenceAnchors
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('./lib/envLoader');

const { transcribeWithTimestamps } = require('../src/services/asr');
const { alignAsrToScript, estimateAnchorsByCharRatio } = require('../src/services/aligner');
const { generatePlan } = require('../src/services/annotationAgent');

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] !== undefined ? m[2] : true;
  }
  return flags;
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const flags = parseArgs(process.argv.slice(2));

  const imagePath = flags.image ? path.resolve(flags.image) : null;
  const scriptArg = flags.script || null;
  const duration = Number(flags.duration) || 0;
  const audioPath = flags.audio ? path.resolve(flags.audio) : '';
  const skipAsr = flags['skip-asr'] !== undefined;

  if (!imagePath || !scriptArg || !duration) {
    console.error('用法：node tools/test-asr.js --image=<png> --script=<txt> --duration=<sec> [--audio=<audio>] [--skip-asr]');
    console.error('');
    console.error('参数说明：');
    console.error('  --image      幻灯片截图路径（必需）');
    console.error('  --script     讲稿文本文件路径或内联文本（必需）');
    console.error('  --duration   视频时长（秒，必需）');
    console.error('  --audio      音频文件路径（可选，用于 ASR）');
    console.error('  --skip-asr   跳过 ASR，仅使用字符占比估算');
    process.exit(1);
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`图片不存在：${imagePath}`);
    process.exit(1);
  }

  let scriptText = scriptArg;
  if (fs.existsSync(scriptArg)) {
    scriptText = fs.readFileSync(scriptArg, 'utf-8');
  }

  if (!scriptText || !scriptText.trim()) {
    console.error('讲稿文本为空');
    process.exit(1);
  }

  const mediaId = flags.mediaId || `test-asr-${Date.now()}`;

  console.log('━'.repeat(70));
  console.log('  ASR 增强强调动画 端到端测试');
  console.log('━'.repeat(70));
  console.log(`  mediaId   : ${mediaId}`);
  console.log(`  duration  : ${duration}s`);
  console.log(`  narration : ${scriptText.length} 字`);
  console.log(`  audio     : ${audioPath && fs.existsSync(audioPath) ? '✓' : '✗'} ${audioPath ? path.basename(audioPath) : '(未提供)'}`);
  console.log(`  thumbnail : ${fs.existsSync(imagePath) ? '✓' : '✗'} ${path.basename(imagePath)}`);
  console.log(`  skip-asr  : ${skipAsr}`);
  console.log('━'.repeat(70));

  // ── Step 1: 生成 sentenceAnchors ──────────────────────
  let sentenceAnchors = [];
  let asrSource = 'char-ratio';

  if (!skipAsr && audioPath && fs.existsSync(audioPath)) {
    console.log('\n[Step 1] 运行 ASR 转写...');
    const tAsr = Date.now();
    try {
      const asr = await transcribeWithTimestamps(audioPath);
      if (asr.sentences && asr.sentences.length) {
        console.log(`  ASR 完成: ${asr.sentences.length} 句 (${((Date.now() - tAsr) / 1000).toFixed(1)}s)`);
        for (const s of asr.sentences) {
          console.log(`    [${(s.beginMs / 1000).toFixed(2)}s → ${(s.endMs / 1000).toFixed(2)}s] ${s.text.slice(0, 50)}`);
        }

        // 对齐到原始讲稿
        console.log('\n[Step 2] ASR → 讲稿对齐...');
        sentenceAnchors = alignAsrToScript(asr.sentences, scriptText);
        asrSource = 'paraformer-v2';
        console.log(`  对齐结果: ${sentenceAnchors.length} 个锚点`);
      } else {
        console.log('  ASR 无结果，回退到字符占比估算');
      }
    } catch (err) {
      console.warn(`  ASR 失败: ${err.message}，回退到字符占比估算`);
    }
  }

  if (!sentenceAnchors.length) {
    console.log('\n[Step 1-fallback] 字符占比估算 sentenceAnchors...');
    sentenceAnchors = estimateAnchorsByCharRatio(scriptText, duration);
    asrSource = 'char-ratio';
  }

  // 打印 anchors
  console.log(`\n  sentenceAnchors (source: ${asrSource}):`);
  for (const a of sentenceAnchors) {
    console.log(`    [${a.index}] ${a.startSec.toFixed(2)}s → ${a.endSec.toFixed(2)}s  "${a.text.slice(0, 40)}"`);
  }

  // ── Step 3: 生成强调动画方案 ───────────────────────────
  console.log('\n[Step 3] 生成强调动画方案 (OCR + VLM + LLM)...');
  const tPlan = Date.now();
  let plan;
  try {
    plan = await generatePlan({
      mediaId,
      sectionId: 'test-section',
      imagePath,
      scriptText,
      duration,
      sentenceAnchors,
      asrSource,
    });
  } catch (err) {
    console.error(`❌ generatePlan 失败: ${err.message}`);
    process.exit(2);
  }
  const planMs = Date.now() - tPlan;

  // ── 输出详细结果 ──────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log(`  强调动画方案生成完成 (${planMs}ms)`);
  console.log('═'.repeat(70));

  const meta = plan.meta || {};
  console.log(`  OCR lines  : ${meta.ocrLines || 0} ${meta.ocrFailed ? '(FAILED)' : ''}`);
  console.log(`  VLM blocks : ${meta.vlmBlocks || 0} ${meta.vlmFailed ? '(FAILED)' : ''}`);
  console.log(`  LLM model  : ${meta.aggModel || 'N/A'} ${meta.llmFailed ? '(FAILED)' : ''}`);
  console.log(`  Fallback   : ${meta.fallback ? 'YES (subtitle mode)' : 'NO (normal mode)'}`);
  console.log(`  Emphases   : ${(plan.emphases || []).length} 条`);

  if (plan.emphases && plan.emphases.length) {
    console.log('\n  详细 emphases:');
    for (const emp of plan.emphases) {
      const matchAnchor = sentenceAnchors.find(a =>
        Math.abs(a.startSec - emp.start) < 0.5
      );
      const anchorMatch = matchAnchor
        ? `✓ 对齐 anchor[${matchAnchor.index}] (Δ=${Math.abs(matchAnchor.startSec - emp.start).toFixed(2)}s)`
        : '✗ 未对齐任何 anchor';

      console.log(`    [${emp.order}] ${emp.start.toFixed(2)}s → ${emp.end.toFixed(2)}s | ${emp.type} | ${emp.keyword || '(无keyword)'}`);
      console.log(`        bbox=[${(emp.bboxNorm || []).map(v => v.toFixed(2)).join(', ')}] conf=${(emp.confidence || 0).toFixed(2)}`);
      console.log(`        ${anchorMatch}`);
      if (emp.scriptSlice) {
        console.log(`        scriptSlice: "${emp.scriptSlice.slice(0, 60)}"`);
      }
    }
  }

  // ── 时间覆盖分析 ──────────────────────────────────────
  if (plan.emphases && plan.emphases.length) {
    console.log('\n  时间覆盖分析:');
    const totalEmpTime = plan.emphases.reduce((s, e) => s + (e.end - e.start), 0);
    const coverage = (totalEmpTime / duration * 100).toFixed(1);
    console.log(`    总动画时间: ${totalEmpTime.toFixed(1)}s / ${duration}s (${coverage}%)`);

    // 间隔检查
    for (let i = 1; i < plan.emphases.length; i++) {
      const gap = plan.emphases[i].start - plan.emphases[i - 1].end;
      const status = gap >= 0.4 ? '✓' : '✗ 间隔不足';
      console.log(`    间隔 [${i - 1}→${i}]: ${gap.toFixed(2)}s ${status}`);
    }
  }

  // ── 保存结果 ──────────────────────────────────────────
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `asr-emphasis-${asrSource}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({
    mediaId,
    asrSource,
    duration,
    narration: scriptText,
    sentenceAnchors,
    plan,
    testTime: new Date().toISOString(),
  }, null, 2), 'utf-8');
  console.log(`\n  结果已保存: ${path.relative(process.cwd(), outputFile)}`);
  console.log('━'.repeat(70));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
