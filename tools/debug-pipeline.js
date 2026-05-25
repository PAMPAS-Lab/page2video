#!/usr/bin/env node

/**
 * debug-pipeline.js — 截图+讲稿 → AnimationPlan 端到端调试入口
 *
 * 用法：
 *   node tools/debug-pipeline.js <thumb.png> <script.txt|"raw text"> <duration_sec> [--mediaId=xxx] [--render]
 *
 * 行为：
 *   - 加载 .env / .alikey（通过 envLoader）
 *   - 调用 annotationAgent.generatePlan 生成 AnimationPlan
 *   - 把 plan 写入 tools/output/<ts>-emphasis-plan.json
 *   - 同时打印每条 emphasis 的可读摘要
 *   - --render：额外调用 HyperFrames 离线渲染生成 emphasis.mp4
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('./lib/envLoader');

const { generatePlan } = require('../src/services/annotationAgent');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      flags[m[1]] = m[2] === undefined ? true : m[2];
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length < 3) {
    console.error('用法：node tools/debug-pipeline.js <thumb.png> <script.txt|"raw text"> <duration_sec> [--mediaId=xxx] [--render]');
    process.exit(1);
  }

  const [pngArg, scriptArg, durationArg] = positional;
  const absImg = path.resolve(pngArg);
  if (!fs.existsSync(absImg)) {
    console.error(`图片不存在：${absImg}`);
    process.exit(1);
  }

  let scriptText = scriptArg;
  if (scriptArg && fs.existsSync(scriptArg)) {
    scriptText = fs.readFileSync(scriptArg, 'utf-8');
  } else if (path.extname(scriptArg).toLowerCase() === '.txt') {
    console.error(`脚本文件不存在：${scriptArg}`);
    process.exit(1);
  }

  const duration = Number(durationArg);
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error(`duration 非法：${durationArg}`);
    process.exit(1);
  }

  const mediaId = flags.mediaId || `debug-${Date.now()}`;
  const doRender = flags.render !== undefined;

  console.log('━'.repeat(60));
  console.log(`debug-pipeline.js`);
  console.log(`  thumb     : ${absImg}`);
  console.log(`  duration  : ${duration}s`);
  console.log(`  scriptLen : ${(scriptText || '').length} 字`);
  console.log(`  mediaId   : ${mediaId}`);
  console.log(`  render    : ${doRender}`);
  console.log(`  AGG_MODEL : ${process.env.EMPHASIS_AGG_MODEL || 'qwen-plus'}`);
  console.log(`  VLM_MODEL : ${process.env.EMPHASIS_VLM_MODEL || 'qwen3.6-flash'}`);
  console.log('━'.repeat(60));

  const tStart = Date.now();
  let plan = null;
  try {
    plan = await generatePlan({
      mediaId,
      sectionId: flags.sectionId || 'debug-section',
      imagePath: absImg,
      scriptText,
      duration,
    });
  } catch (err) {
    console.error(`❌ generatePlan 抛出异常：${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(2);
  }
  const elapsedMs = Date.now() - tStart;

  // 输出摘要
  console.log(`\n✅ plan 生成完成 (${elapsedMs}ms)`);
  console.log(`   imageSize: ${plan.imageSize.w}×${plan.imageSize.h}`);
  console.log(`   emphases : ${plan.emphases.length} 条`);
  console.log(`   meta     : ${JSON.stringify(plan.meta || {}, null, 2).split('\n').map((l, i) => i === 0 ? l : '              ' + l).join('\n')}`);
  console.log('');
  for (const e of plan.emphases) {
    const bbox = e.bboxNorm.map(v => Number(v).toFixed(3)).join(',');
    const conf = typeof e.confidence === 'number' ? e.confidence.toFixed(2) : '?';
    console.log(`   #${e.order} [${e.start.toFixed(2)}~${e.end.toFixed(2)}s] ${e.type.padEnd(15)} kind=${e.kind.padEnd(5)} conf=${conf}`);
    console.log(`        bbox=[${bbox}]`);
    if (e.keyword) console.log(`        keyword=${JSON.stringify(e.keyword)}`);
    if (e.scriptSlice) console.log(`        scriptSlice=${JSON.stringify(e.scriptSlice.slice(0, 60))}…`);
  }

  // 保存
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `${ts}-emphasis-plan.json`);
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf-8');
  console.log(`\n📄 完整 plan 已保存：${outPath}`);

  // ── --render：HyperFrames 离线渲染为 MP4 ──
  if (doRender) {
    console.log('\n' + '━'.repeat(60));
    console.log('🎬 HyperFrames 离线渲染...');
    console.log('━'.repeat(60));

    const { planToHyperframesHtml, renderEmphasisMp4 } = require('../src/services/hyperframes');

    // 生成 HTML
    const html = planToHyperframesHtml(plan, 'playback.mp4');
    const htmlPath = path.join(outDir, `${ts}-emphasis.html`);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    console.log(`📄  HyperFrames HTML 已保存：${htmlPath}`);

    // 检查是否有现成的静态视频
    const mediaDir = path.join(__dirname, '..', 'media');
    const mediaPkgDir = path.join(mediaDir, mediaId);
    let videoPath = null;
    if (fs.existsSync(mediaPkgDir)) {
      const candidate = path.join(mediaPkgDir, 'playback.mp4');
      if (fs.existsSync(candidate)) {
        videoPath = candidate;
      }
    }

    if (videoPath) {
      const taskId = `debug-${ts}`;
      try {
        console.log('  正在渲染... (可能需要 30-60s)');
        const mp4Path = await renderEmphasisMp4(taskId, plan, { videoPath });
        if (mp4Path && fs.existsSync(mp4Path)) {
          const sizeMB = (fs.statSync(mp4Path).size / 1024 / 1024).toFixed(1);
          console.log(`✅ MP4 已生成：${mp4Path} (${sizeMB} MB)`);
        } else {
          console.log('⚠️  渲染完成但未找到输出 MP4');
        }
      } catch (renderErr) {
        console.error(`❌ HyperFrames 渲染失败：${renderErr.message}`);
      }
    } else {
      console.log('⚠️  未找到对应的静态视频（media/<mediaId>/playback.mp4）');
      console.log('   需要提供视频文件，或先通过其他流程生成视频');
      console.log('   仅生成 HTML（跳过 MP4 渲染）');
    }
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
