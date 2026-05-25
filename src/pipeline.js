/**
 * pipeline.js — 主编排：ASR → generatePlan → renderMp4 + 渲染队列
 *
 * 提供完整的端到端流程编排，以及 FIFO 串行渲染队列。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { generatePlan } = require('./services/annotationAgent');
const { renderEmphasisMp4 } = require('./services/hyperframes');
const { transcribeWithTimestamps, isAsrEnabled } = require('./services/asr');
const { alignAsrToScript, estimateAnchorsByCharRatio } = require('./services/aligner');
const fileStore = require('./store/fileStore');
const config = require('./config');

// ── taskId 生成 ─────────────────────────────────────────────

function generateTaskId() {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ── 按需 ASR ────────────────────────────────────────────────

/**
 * 如果提供了音频路径且没有 sentenceAnchors，运行 ASR + 对齐
 * @param {object} input - { audioPath, scriptText, duration, sentenceAnchors? }
 * @returns {Promise<{ sentenceAnchors: Array, asrSource: string }>}
 */
async function resolveSentenceAnchors(input) {
  const existingAnchors = Array.isArray(input.sentenceAnchors) ? input.sentenceAnchors : [];
  if (existingAnchors.length) {
    return { sentenceAnchors: existingAnchors, asrSource: input.asrSource || 'provided' };
  }

  const { scriptText, duration, audioPath } = input;
  if (!scriptText || !scriptText.trim()) {
    return { sentenceAnchors: [], asrSource: 'none' };
  }

  // 尝试 ASR
  if (audioPath && fs.existsSync(audioPath) && isAsrEnabled()) {
    try {
      console.log(`[pipeline] running ASR on ${path.basename(audioPath)}...`);
      const asr = await transcribeWithTimestamps(audioPath);
      if (asr.sentences && asr.sentences.length) {
        const aligned = alignAsrToScript(asr.sentences, scriptText);
        if (aligned && aligned.length) {
          console.log(`[pipeline] ASR aligned: ${aligned.length} anchors`);
          return { sentenceAnchors: aligned, asrSource: 'paraformer-v2' };
        }
      }
    } catch (err) {
      console.warn(`[pipeline] ASR failed:`, err?.message || err);
    }
  }

  // 兜底：字符占比
  const anchors = estimateAnchorsByCharRatio(scriptText, duration || 30);
  return { sentenceAnchors: anchors, asrSource: 'char-ratio' };
}

// ── 渲染队列（FIFO 串行 + 去重）──────────────────────────────

const renderQueue = [];
let isRendering = false;

function enqueueRender(taskId, plan) {
  const alreadyQueued = renderQueue.some((t) => t.taskId === taskId);
  if (alreadyQueued) {
    console.log(`[pipeline] render already queued for ${taskId}, skipping`);
    return;
  }

  renderQueue.push({ taskId, plan });
  console.log(`[pipeline] render queued for ${taskId} (queue length: ${renderQueue.length})`);
  processRenderQueue();
}

function processRenderQueue() {
  if (isRendering || renderQueue.length === 0) return;

  isRendering = true;
  const { taskId, plan } = renderQueue.shift();

  console.log(`[pipeline] starting render for ${taskId} (remaining: ${renderQueue.length})`);

  fileStore.upsertTask(taskId, { renderingStatus: 'rendering' });

  renderEmphasisMp4(taskId, plan, { quality: 'draft' })
    .then(({ mp4Path, elapsedMs }) => {
      fileStore.upsertTask(taskId, {
        renderingStatus: 'done',
        mp4Path,
        mp4Url: `/api/v1/media/${taskId}/emphasis.mp4`,
        renderElapsedMs: elapsedMs,
      });
      console.log(`[pipeline] render done for ${taskId} (${elapsedMs}ms)`);
    })
    .catch((err) => {
      console.warn(`[pipeline] render failed for ${taskId}:`, err.message || err);
      fileStore.upsertTask(taskId, {
        renderingStatus: 'failed',
        renderError: String(err.message || err),
      });
    })
    .finally(() => {
      isRendering = false;
      setImmediate(processRenderQueue);
    });
}

// ── 完整流程 ────────────────────────────────────────────────

/**
 * 运行完整流程：ASR → generatePlan → renderMp4
 *
 * @param {object} input
 * @param {string} input.imagePath - 截图绝对路径
 * @param {string} input.scriptText - 讲稿文本
 * @param {number} input.duration - 时长（秒）
 * @param {string} [input.audioPath] - 音频路径（可选，用于 ASR）
 * @param {Array} [input.sentenceAnchors] - 预计算的句子锚点
 * @param {string} [input.taskId] - 自定义 taskId（不传则自动生成）
 * @returns {Promise<{ taskId: string, plan: object }>}
 */
async function runFullPipeline(input) {
  const taskId = input.taskId || generateTaskId();
  const { scriptText, duration, imagePath } = input;

  // 1. 初始化任务状态
  fileStore.upsertTask(taskId, {
    status: 'pending',
    input: { imagePath, scriptText: (scriptText || '').slice(0, 200), duration },
    createdAt: new Date().toISOString(),
  });

  try {
    // 2. 解析 sentenceAnchors（ASR or 字符占比）
    const { sentenceAnchors, asrSource } = await resolveSentenceAnchors(input);

    // 3. 生成 plan
    const plan = await generatePlan({
      mediaId: taskId,
      imagePath,
      scriptText,
      duration,
      sentenceAnchors,
      asrSource,
    });

    // 4. 更新状态
    fileStore.upsertTask(taskId, {
      status: 'ready',
      plan,
      sentenceAnchors,
      asrSource,
      generatedAt: new Date().toISOString(),
      renderingStatus: 'rendering',
    });

    // 5. 入队渲染
    enqueueRender(taskId, plan);

    return { taskId, plan };
  } catch (err) {
    fileStore.upsertTask(taskId, {
      status: 'failed',
      error: String(err.message || err),
      renderingStatus: 'idle',
    });
    throw err;
  }
}

module.exports = {
  generateTaskId,
  resolveSentenceAnchors,
  runFullPipeline,
  enqueueRender,
};
