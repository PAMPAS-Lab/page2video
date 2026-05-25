/**
 * index.js — 入口：Express 启动 + 库 API 导出
 *
 * 双模式使用：
 *   1. 作为服务：node src/index.js
 *   2. 作为库：const { generatePlan, createApp } = require('static-page-to-video')
 */

'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const { createRouter } = require('./routes/api');
const { createFrontendRouter } = require('./routes/frontend');

// ── Express App 工厂 ────────────────────────────────────────

function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));

  // 健康检查
  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'static-page-to-video', version: '0.1.0' });
  });

  // 挂载 API 路由
  app.use('/api/v1', createRouter());

  // 挂载前端交互路由
  app.use('/api/v1', createFrontendRouter());

  // 静态文件服务（前端页面）
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 前端 fallback：SPA 路由
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // 全局错误处理
  app.use((err, req, res, _next) => {
    console.error('[server] unhandled error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

// ── 启动服务 ────────────────────────────────────────────────

if (require.main === module) {
  const port = config.getPort();
  const app = createApp();
  app.listen(port, () => {
    console.log(`static-page-to-video server listening on http://localhost:${port}`);
    console.log(`  Frontend: http://localhost:${port}/`);
    console.log(`  Health:   GET  http://localhost:${port}/health`);
    console.log(`  API:      POST http://localhost:${port}/api/v1/generate`);
    console.log(`  Status:   GET  http://localhost:${port}/api/v1/task/:taskId`);
  });
}

// ── 库 API 导出 ─────────────────────────────────────────────

const { generatePlan, generatePlanFromDetection, runDetection, buildAggregationPrompt } = require('./services/annotationAgent');
const { planToHyperframesHtml, renderEmphasisMp4, resolveMediaPaths } = require('./services/hyperframes');
const { transcribeWithTimestamps } = require('./services/asr');
const { alignAsrToScript, estimateAnchorsByCharRatio } = require('./services/aligner');
const { validateAnimationPlan, sanitizeAnimationPlan, createFallbackPlan } = require('./services/planSchema');
const { synthesizeSpeech, probeAudioDuration } = require('./services/tts');
const { runFullPipeline } = require('./pipeline');

module.exports = {
  // App
  createApp,
  // Pipeline
  runFullPipeline,
  // Plan generation
  generatePlan,
  generatePlanFromDetection,
  runDetection,
  buildAggregationPrompt,
  // HyperFrames
  planToHyperframesHtml,
  renderEmphasisMp4,
  resolveMediaPaths,
  // ASR
  transcribeWithTimestamps,
  alignAsrToScript,
  estimateAnchorsByCharRatio,
  // TTS
  synthesizeSpeech,
  probeAudioDuration,
  // Schema
  validateAnimationPlan,
  sanitizeAnimationPlan,
  createFallbackPlan,
};
