/**
 * frontend.js — 前端交互用 API 路由
 *
 * POST /api/v1/upload/image             — 上传图片
 * POST /api/v1/upload/audio             — 上传音频
 * POST /api/v1/tts                      — TTS 合成讲稿
 * GET  /api/v1/tasks                    — 列出所有任务
 * POST /api/v1/task/:taskId/detect      — 运行 OCR+VLM 检测（不生成 plan）
 * GET  /api/v1/task/:taskId/detection   — 获取检测结果
 * PUT  /api/v1/task/:taskId/detection   — 保存（编辑过的）检测结果
 * POST /api/v1/task/:taskId/plan        — 基于检测结果生成 plan
 * GET  /api/v1/task/:taskId/plan        — 获取 plan
 * PUT  /api/v1/task/:taskId/plan        — 保存（编辑过的）plan
 * POST /api/v1/task/:taskId/render      — 触发 MP4 渲染
 * GET  /api/v1/uploads/:filename        — 静态文件服务（图片+音频）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { execFileSync } = require('child_process');

const fileStore = require('../store/fileStore');
const config = require('../config');
const { runDetection, generatePlanFromDetection } = require('../services/annotationAgent');
const { renderEmphasisMp4, resolveMediaPaths } = require('../services/hyperframes');
const { validateAnimationPlan, sanitizeAnimationPlan } = require('../services/planSchema');
const { synthesizeSpeech, probeAudioDuration } = require('../services/tts');
const { transcribeWithTimestamps, isAsrEnabled } = require('../services/asr');
const { alignAsrToScript, estimateAnchorsByCharRatio } = require('../services/aligner');

// ── 辅助函数 ──────────────────────────────────────────────────

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

// ── Multer 配置 ──────────────────────────────────────────────

const UPLOADS_DIR = path.join(config.getMediaDir(), '_uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    const isAudioField = file.fieldname === 'audio';
    const allowed = isAudioField ? audioExts : imageExts;
    const maxSize = isAudioField ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > maxSize) {
      return cb(new Error(`File too large (max ${isAudioField ? '50' : '20'}MB)`));
    }
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

// ── 路由注册 ──────────────────────────────────────────────────

function createFrontendRouter() {
  const router = express.Router();

  // POST /api/v1/upload/image
  router.post('/upload/image', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return jsonFail(res, 413, 'File too large (max 20MB)');
        }
        return jsonFail(res, 400, err.message || 'Upload error');
      }
      if (!req.file) {
        return jsonFail(res, 400, 'No image file provided');
      }

      const filePath = req.file.path;
      const filename = req.file.filename;
      const imageUrl = `/api/v1/uploads/${filename}`;

      return jsonOk(res, {
        imagePath: filePath,
        imageUrl,
        filename,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });
    });
  });

  // POST /api/v1/upload/audio — 上传音频文件
  router.post('/upload/audio', (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return jsonFail(res, 413, 'File too large (max 50MB)');
        }
        return jsonFail(res, 400, err.message || 'Upload error');
      }
      if (!req.file) {
        return jsonFail(res, 400, 'No audio file provided');
      }

      const filePath = req.file.path;
      const filename = req.file.filename;
      const audioUrl = `/api/v1/uploads/${filename}`;
      const duration = probeAudioDuration(filePath);

      return jsonOk(res, {
        audioPath: filePath,
        audioUrl,
        filename,
        duration,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });
    });
  });

  // POST /api/v1/tts — TTS 合成讲稿
  router.post('/tts', wrap(async (req, res) => {
    const { text, voice, rate, taskId: reqTaskId } = req.body || {};
    if (!text || !text.trim()) {
      return jsonFail(res, 400, 'text is required');
    }

    const taskId = reqTaskId || `tts_${Date.now()}`;
    const taskDir = path.join(config.getMediaDir(), taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    const outputPath = path.join(taskDir, 'narration.mp3');

    try {
      const result = await synthesizeSpeech(text, {
        outputPath,
        voice,
        rate: rate ? Number(rate) : undefined,
      });

      // 保存 TTS 结果到任务
      const existing = fileStore.getTask(taskId);
      fileStore.upsertTask(taskId, {
        tts: {
          audioPath: result.audioPath,
          audioUrl: `/api/v1/media/${taskId}/narration.mp3`,
          duration: result.duration,
          model: result.model,
          voice: result.voice,
          characters: result.characters,
          elapsedMs: result.elapsedMs,
        },
        input: {
          ...(existing?.input || {}),
          scriptText: text,
          duration: result.duration,
        },
      });

      return jsonOk(res, {
        taskId,
        audioPath: result.audioPath,
        audioUrl: `/api/v1/media/${taskId}/narration.mp3`,
        duration: result.duration,
        model: result.model,
        voice: result.voice,
      });
    } catch (err) {
      return jsonFail(res, 500, `TTS failed: ${err.message || err}`);
    }
  }));

  // GET /api/v1/uploads/:filename — 静态文件服务（图片+音频）
  router.get('/uploads/:filename', (req, res) => {
    const { filename } = req.params;
    // 安全：只允许访问 _uploads 目录
    const safeName = path.basename(filename);
    const filePath = path.join(UPLOADS_DIR, safeName);
    const resolved = path.resolve(filePath);
    const allowed = path.resolve(UPLOADS_DIR);
    if (!resolved.startsWith(allowed)) {
      return jsonFail(res, 403, 'Access denied');
    }
    if (!fs.existsSync(resolved)) {
      return jsonFail(res, 404, 'File not found');
    }
    const { serveStaticFile } = require('./api');
    serveStaticFile(req, res, resolved);
  });

  // GET /api/v1/tasks — 列出所有任务
  router.get('/tasks', wrap(async (req, res) => {
    const store = fileStore.readStore();
    const tasks = Object.values(store.tasks || {})
      .map(t => ({
        taskId: t.taskId,
        status: t.status || 'idle',
        renderingStatus: t.renderingStatus || 'idle',
        createdAt: t.createdAt || null,
        updatedAt: t.updatedAt || null,
        hasDetection: !!t.detection,
        hasPlan: !!t.plan,
        mp4Url: t.renderingStatus === 'done' ? t.mp4Url : null,
        error: t.error || null,
      }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return jsonOk(res, { tasks });
  }));

  // POST /api/v1/task/:taskId/detect — 运行 OCR+VLM 检测
  router.post('/task/:taskId/detect', wrap(async (req, res) => {
    const { taskId } = req.params;
    if (!taskId) return jsonFail(res, 400, 'taskId is required');

    const task = fileStore.getTask(taskId);
    if (!task) {
      // 自动创建任务记录
      fileStore.upsertTask(taskId, {
        status: 'detecting',
        createdAt: new Date().toISOString(),
        input: req.body || {},
      });
    }

    const { imagePath } = req.body || task?.input || {};
    if (!imagePath) return jsonFail(res, 400, 'imagePath is required');
    if (!fs.existsSync(imagePath)) {
      return jsonFail(res, 400, `imagePath not found: ${imagePath}`);
    }

    // Duration: request body > task.input > task.tts
    const duration = req.body?.duration || task?.input?.duration || task?.tts?.duration;

    fileStore.upsertTask(taskId, { status: 'detecting' });

    try {
      const detection = await runDetection({
        mediaId: taskId,
        imagePath,
        duration,
      });

      fileStore.upsertTask(taskId, {
        status: 'detected',
        detection,
        input: {
          ...(task?.input || {}),
          imagePath,
          scriptText: req.body?.scriptText || task?.input?.scriptText,
          duration: duration || task?.input?.duration,
          audioPath: req.body?.audioPath || task?.input?.audioPath,
          audioUrl: req.body?.audioUrl || task?.input?.audioUrl,
        },
      });

      return jsonOk(res, { taskId, status: 'detected', detection });
    } catch (err) {
      fileStore.upsertTask(taskId, {
        status: 'detect_failed',
        error: String(err.message || err),
      });
      return jsonFail(res, 500, `Detection failed: ${err.message || err}`);
    }
  }));

  // GET /api/v1/task/:taskId/detection — 获取检测结果
  router.get('/task/:taskId/detection', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    return jsonOk(res, {
      taskId,
      status: task.status,
      detection: task.detection || null,
    });
  }));

  // PUT /api/v1/task/:taskId/detection — 保存编辑过的检测结果
  router.put('/task/:taskId/detection', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    const { ocrLines, vlmBlocks, imageSize } = req.body || {};

    const detection = {
      ...(task.detection || {}),
      mediaId: taskId,
      ocrLines: Array.isArray(ocrLines) ? ocrLines : (task.detection?.ocrLines || []),
      vlmBlocks: Array.isArray(vlmBlocks) ? vlmBlocks : (task.detection?.vlmBlocks || []),
      imageSize: imageSize || task.detection?.imageSize || { w: 1920, h: 1080 },
      editedAt: new Date().toISOString(),
    };

    fileStore.upsertTask(taskId, {
      detection,
      status: 'detected', // 重置为 detected，表示可重新生成 plan
    });

    return jsonOk(res, { taskId, status: 'detected', detection });
  }));

  // POST /api/v1/task/:taskId/plan — 基于检测结果生成 plan
  router.post('/task/:taskId/plan', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    const detection = task.detection;
    if (!detection) {
      return jsonFail(res, 400, 'No detection result found. Run detect first.');
    }

    let { scriptText, sentenceAnchors, asrSource } = req.body || task.input || {};
    const duration = req.body?.duration || task.input?.duration || task.tts?.duration;
    if (!scriptText) return jsonFail(res, 400, 'scriptText is required');
    if (!duration || Number(duration) <= 0) return jsonFail(res, 400, 'duration must be a positive number (generate TTS or upload audio first)');

    // Auto-run ASR if no sentenceAnchors provided and audio exists
    if (!sentenceAnchors || !sentenceAnchors.length) {
      const audioPath = task.tts?.audioPath || task.input?.audioPath;
      if (audioPath && fs.existsSync(audioPath) && isAsrEnabled()) {
        try {
          console.log(`[plan] Running ASR for ${taskId}...`);
          const asr = await transcribeWithTimestamps(audioPath);
          if (asr.sentences && asr.sentences.length) {
            sentenceAnchors = alignAsrToScript(asr.sentences, scriptText);
            asrSource = 'paraformer-v2';
            console.log(`[plan] ASR aligned: ${sentenceAnchors.length} anchors`);
          }
        } catch (asrErr) {
          console.warn(`[plan] ASR failed, falling back to char-ratio:`, asrErr.message);
        }
      }
      // Fallback to char-ratio if ASR didn't produce anchors
      if (!sentenceAnchors || !sentenceAnchors.length) {
        sentenceAnchors = estimateAnchorsByCharRatio(scriptText, Number(duration));
        asrSource = asrSource || 'char-ratio';
      }
    }

    fileStore.upsertTask(taskId, { status: 'planning' });

    try {
      const plan = await generatePlanFromDetection(
        {
          mediaId: taskId,
          imagePath: task.input?.imagePath,
          scriptText,
          duration: Number(duration),
          sentenceAnchors,
          asrSource,
        },
        detection,
      );

      fileStore.upsertTask(taskId, {
        status: 'ready',
        plan,
        sentenceAnchors,
        asrSource,
        input: {
          ...(task.input || {}),
          scriptText,
          duration: Number(duration),
        },
        generatedAt: new Date().toISOString(),
      });

      return jsonOk(res, { taskId, status: 'ready', plan, sentenceAnchors, asrSource });
    } catch (err) {
      fileStore.upsertTask(taskId, {
        status: 'plan_failed',
        error: String(err.message || err),
      });
      return jsonFail(res, 500, `Plan generation failed: ${err.message || err}`);
    }
  }));

  // GET /api/v1/task/:taskId/plan — 获取 plan
  router.get('/task/:taskId/plan', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    return jsonOk(res, {
      taskId,
      status: task.status,
      plan: task.plan || null,
      generatedAt: task.generatedAt || null,
    });
  }));

  // PUT /api/v1/task/:taskId/plan — 保存编辑过的 plan
  router.put('/task/:taskId/plan', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    const plan = req.body;
    if (!plan || !plan.emphases) {
      return jsonFail(res, 400, 'Invalid plan: must have emphases array');
    }

    // 校验 plan
    const v = validateAnimationPlan(plan);
    let finalPlan = plan;
    if (!v.valid && v.sanitized) {
      finalPlan = sanitizeAnimationPlan(plan);
    }

    fileStore.upsertTask(taskId, {
      plan: finalPlan,
      status: 'ready',
      planEditedAt: new Date().toISOString(),
    });

    return jsonOk(res, { taskId, status: 'ready', plan: finalPlan });
  }));

  // ── 公共函数：确保 playback.mp4 存在 ──────────────────
  function ensurePlaybackVideo(task, taskId) {
    const { videoPath, taskDir } = resolveMediaPaths(taskId);
    if (fs.existsSync(videoPath)) {
      return { videoPath, playbackUrl: `/api/v1/media/${taskId}/playback.mp4` };
    }

    const imagePath = task.input?.imagePath;
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error('No source image or video found.');
    }

    fs.mkdirSync(taskDir, { recursive: true });

    // Look for audio in multiple places: tts.audioPath, input.audioPath
    const audioPath = task.tts?.audioPath || task.input?.audioPath;
    const duration = task.input?.duration || task.plan?.duration || 30;

    if (audioPath && fs.existsSync(audioPath)) {
      execFileSync('ffmpeg', [
        '-y', '-loop', '1', '-i', imagePath,
        '-i', audioPath,
        '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '128k',
        '-pix_fmt', 'yuv420p', '-shortest',
        '-movflags', '+faststart',
        videoPath,
      ], { timeout: 120000, stdio: 'pipe' });
    } else {
      execFileSync('ffmpeg', [
        '-y', '-loop', '1', '-i', imagePath,
        '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast',
        '-t', String(duration),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        videoPath,
      ], { timeout: 120000, stdio: 'pipe' });
    }
    console.log(`[playback] Generated playback.mp4 for ${taskId}`);
    return { videoPath, playbackUrl: `/api/v1/media/${taskId}/playback.mp4` };
  }

  // POST /api/v1/task/:taskId/playback — 生成底片视频
  router.post('/task/:taskId/playback', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    try {
      // Force regenerate: delete existing playback.mp4 to ensure fresh audio
      const { videoPath } = resolveMediaPaths(taskId);
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
      const { playbackUrl } = ensurePlaybackVideo(task, taskId);
      return jsonOk(res, { taskId, playbackUrl });
    } catch (err) {
      return jsonFail(res, 500, `Failed to generate playback video: ${err.message?.slice(0, 200)}`);
    }
  }));

  // POST /api/v1/task/:taskId/render — 触发渲染
  router.post('/task/:taskId/render', wrap(async (req, res) => {
    const { taskId } = req.params;
    const task = fileStore.getTask(taskId);
    if (!task) return jsonFail(res, 404, 'Task not found');

    const plan = task.plan;
    if (!plan) {
      return jsonFail(res, 400, 'No plan found. Generate plan first.');
    }

    // 确保 playback.mp4 存在
    try {
      ensurePlaybackVideo(task, taskId);
    } catch (err) {
      return jsonFail(res, 400, err.message);
    }

    fileStore.upsertTask(taskId, { renderingStatus: 'rendering', renderError: null });

    // 异步渲染
    setImmediate(() => {
      renderEmphasisMp4(taskId, plan, { quality: req.body?.quality || 'draft' })
        .then(({ mp4Path, elapsedMs }) => {
          fileStore.upsertTask(taskId, {
            renderingStatus: 'done',
            mp4Path,
            mp4Url: `/api/v1/media/${taskId}/emphasis.mp4`,
            renderElapsedMs: elapsedMs,
          });
        })
        .catch((err) => {
          fileStore.upsertTask(taskId, {
            renderingStatus: 'failed',
            renderError: String(err.message || err),
          });
        });
    });

    return jsonOk(res, { taskId, renderingStatus: 'rendering', message: 'Render started' });
  }));

  return router;
}

module.exports = { createFrontendRouter };
