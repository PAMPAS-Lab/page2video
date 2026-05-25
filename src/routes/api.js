/**
 * api.js — Express 路由
 *
 * POST /api/v1/generate              — 提交生成任务
 * GET  /api/v1/task/:taskId          — 查询任务状态
 * POST /api/v1/task/:taskId/regenerate — 重新生成
 * GET  /api/v1/media/:taskId/:filename — 静态文件服务
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const fileStore = require('../store/fileStore');
const config = require('../config');
const { runFullPipeline, generateTaskId } = require('../pipeline');
const { resolveMediaPaths } = require('../services/hyperframes');

// ── 辅助函数 ────────────────────────────────────────────────

function jsonOk(res, data) {
  return res.json({ ok: true, ...data });
}

function jsonFail(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── 可选 API Key 鉴权 ──────────────────────────────────────

function apiKeyAuth(req, res, next) {
  const requiredKey = config.getApiKey();
  if (!requiredKey) return next(); // 未配置则跳过鉴权

  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== requiredKey) {
    return jsonFail(res, 401, 'Invalid or missing API key');
  }
  next();
}

// ── 路由注册 ────────────────────────────────────────────────

function createRouter() {
  const router = express.Router();

  router.use(apiKeyAuth);

  // POST /api/v1/generate
  router.post('/generate', wrap(async (req, res) => {
    const { imagePath, scriptText, duration, audioPath, sentenceAnchors } = req.body || {};

    if (!imagePath) return jsonFail(res, 400, 'imagePath is required');
    if (!scriptText) return jsonFail(res, 400, 'scriptText is required');
    if (!duration || Number(duration) <= 0) return jsonFail(res, 400, 'duration must be a positive number');

    if (!fs.existsSync(imagePath)) {
      return jsonFail(res, 400, `imagePath not found: ${imagePath}`);
    }

    const taskId = generateTaskId();

    // 异步触发流程，立即返回 taskId
    setImmediate(() => {
      runFullPipeline({
        taskId,
        imagePath,
        scriptText,
        duration: Number(duration),
        audioPath,
        sentenceAnchors,
      }).catch((err) => {
        console.warn(`[api] pipeline failed for ${taskId}:`, err.message || err);
      });
    });

    return jsonOk(res, { taskId, status: 'pending', message: 'Task submitted' });
  }));

  // GET /api/v1/task/:taskId
  router.get('/task/:taskId', wrap(async (req, res) => {
    const { taskId } = req.params;
    if (!taskId) return jsonFail(res, 400, 'taskId is required');

    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    // Check if playback.mp4 exists on disk
    const { videoPath } = resolveMediaPaths(taskId);
    const playbackUrl = fs.existsSync(videoPath) ? `/api/v1/media/${taskId}/playback.mp4` : null;

    return jsonOk(res, {
      taskId: task.taskId,
      status: task.status || 'idle',
      plan: task.plan || null,
      generatedAt: task.generatedAt || null,
      error: task.error || null,
      renderingStatus: task.renderingStatus || 'idle',
      mp4Url: task.renderingStatus === 'done' ? task.mp4Url : null,
      renderElapsedMs: task.renderElapsedMs || null,
      playbackUrl,
      renderError: task.renderError || null,
      createdAt: task.createdAt || null,
      input: task.input || null,
      sentenceAnchors: task.sentenceAnchors || null,
      asrSource: task.asrSource || null,
      tts: task.tts ? { audioUrl: task.tts.audioUrl, duration: task.tts.duration } : null,
    });
  }));

  // POST /api/v1/task/:taskId/regenerate
  router.post('/task/:taskId/regenerate', wrap(async (req, res) => {
    const { taskId } = req.params;
    if (!taskId) return jsonFail(res, 400, 'taskId is required');

    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    // 清除旧渲染产物
    const { exportDir, mp4OutputPath } = resolveMediaPaths(taskId);
    setImmediate(() => {
      try {
        for (const f of [mp4OutputPath, path.join(exportDir, 'index.html'),
                          path.join(exportDir, 'hyperframes.json'),
                          path.join(exportDir, 'playback.mp4')]) {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      } catch (_) { /* silent */ }
    });

    // 重新触发流程（使用原始输入）
    const originalInput = task.input || {};
    const newInput = { ...originalInput, taskId };

    fileStore.upsertTask(taskId, {
      status: 'pending',
      plan: null,
      renderingStatus: 'idle',
      mp4Url: null,
      renderError: null,
      error: null,
    });

    setImmediate(() => {
      runFullPipeline(newInput).catch((err) => {
        console.warn(`[api] regenerate failed for ${taskId}:`, err.message || err);
      });
    });

    return jsonOk(res, { taskId, status: 'pending', message: 'Regeneration submitted' });
  }));

  // GET /api/v1/media/:taskId/:filename — 静态文件服务
  router.get('/media/:taskId/:filename', (req, res) => {
    const { taskId, filename } = req.params;
    const mediaDir = config.getMediaDir();

    // 路径安全：防止路径遍历
    const safeName = path.basename(filename);
    const taskDir = path.join(mediaDir, taskId);
    const allowed = path.resolve(taskDir);

    // 先查找 export/ 目录，再查找任务根目录
    const candidates = [
      path.join(taskDir, 'export', safeName),
      path.join(taskDir, safeName),
    ];

    let filePath = null;
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (!resolved.startsWith(allowed)) continue;
      if (fs.existsSync(resolved)) {
        filePath = resolved;
        break;
      }
    }

    if (!filePath) {
      return jsonFail(res, 404, 'File not found');
    }

    serveStaticFile(req, res, filePath);
  });

  return router;
}

/**
 * Serve a static file with proper Content-Length and Range support
 */
function serveStaticFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.html': 'text/html',
    '.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Handle Range requests (required for video/audio seeking)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

module.exports = { createRouter, serveStaticFile };
