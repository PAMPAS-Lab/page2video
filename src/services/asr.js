/**
 * sentenceAsr.js — DashScope Paraformer-v2 ASR 调用封装
 *
 * Day 6 核心模块：
 *   - 上传音频到 DashScope → 提交文件转写任务 → 轮询 → 返回句子级时间戳
 *   - 复用 DASHSCOPE_API_KEY，零新依赖（axios/form-data 项目已有）
 *   - 日志格式与项目 LLM 模块一致：[asr] → / ←
 *
 * 导出：
 *   transcribeWithTimestamps(audioPath, options) → { sentences, elapsedMs }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com';
const ASR_MODEL = process.env.EMPHASIS_ASR_MODEL || 'paraformer-v2';
const DEFAULT_TIMEOUT_MS = Number(process.env.EMPHASIS_ASR_TIMEOUT_MS) || 60000;
const MAX_POLL_ATTEMPTS = 120; // 最多轮询 120 次 × 1s = 120s
const POLL_INTERVAL_MS = 1000;

/**
 * 检查 ASR 是否启用（可通过 EMPHASIS_ASR_ENABLED=false 关闭，直走字符占比兜底）
 */
function isAsrEnabled() {
  const val = String(process.env.EMPHASIS_ASR_ENABLED || 'true').trim().toLowerCase();
  return val !== 'false' && val !== '0' && val !== 'no';
}

/**
 * 小工具：睡眠
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * 上传音频文件到 DashScope 临时存储，获取 oss:// URL
 *
 * DashScope 文件上传两步流程（官方文档）：
 *   1. GET /api/v1/uploads?action=getPolicy&model=paraformer-v2  → 获取 OSS 上传凭证
 *   2. POST upload_host（阿里云 OSS） → 上传文件 → 得到 oss:// 前缀的临时 URL
 *
 * 注意：临时 URL 有效期 48h，文件上传凭证接口限流 100QPS。
 * 调用转写 API 时需在请求头添加 X-DashScope-OssResourceResolve: enable。
 *
 * @param {string} audioPath - 音频文件绝对路径
 * @param {string} apiKey - DashScope API key
 * @returns {Promise<string>} oss:// 格式的文件 URL
 */
async function uploadAudioFile(audioPath, apiKey) {
  const resolvedPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`音频文件不存在：${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  const fileName = path.basename(resolvedPath);
  console.log(`[asr] → uploading | file=${fileName} | size=${(stat.size / 1024).toFixed(1)}KB`);

  // Step 1: 获取 OSS 上传凭证
  let policyData;
  try {
    const policyResp = await axios.get(`${DASHSCOPE_BASE}/api/v1/uploads`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      params: { action: 'getPolicy', model: ASR_MODEL },
      timeout: 15000,
    });
    policyData = policyResp.data?.data;
    if (!policyData || !policyData.upload_host || !policyData.upload_dir) {
      throw new Error(`返回数据缺少必要字段：${JSON.stringify(policyResp.data).slice(0, 300)}`);
    }
  } catch (error) {
    const msg = error.response?.data?.message || error.message || 'unknown';
    throw new Error(`DashScope 获取上传凭证失败：${msg}`);
  }

  // Step 2: 上传文件到 OSS
  const ossKey = `${policyData.upload_dir}/${fileName}`;
  const formData = new FormData();
  formData.append('OSSAccessKeyId', policyData.oss_access_key_id);
  formData.append('Signature', policyData.signature);
  formData.append('policy', policyData.policy);
  formData.append('x-oss-object-acl', policyData.x_oss_object_acl);
  formData.append('x-oss-forbid-overwrite', policyData.x_oss_forbid_overwrite);
  formData.append('key', ossKey);
  formData.append('success_action_status', '200');
  formData.append('file', fs.createReadStream(resolvedPath), {
    filename: fileName,
    knownLength: stat.size,
  });

  try {
    await axios.post(policyData.upload_host, formData, {
      headers: formData.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (error) {
    const msg = error.response?.data || error.message || 'unknown';
    throw new Error(`OSS 文件上传失败：${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)}`);
  }

  const ossUrl = `oss://${ossKey}`;
  console.log(`[asr] upload OK | url=${ossUrl}`);
  return ossUrl;
}

/**
 * 提交文件转写任务
 *
 * @param {string} fileUrl - DashScope 上传后的文件 URL
 * @param {string} apiKey - DashScope API key
 * @returns {Promise<string>} task_id
 */
async function submitTranscriptionTask(fileUrl, apiKey) {
  const payload = {
    model: ASR_MODEL,
    input: { file_urls: [fileUrl] },
    parameters: {
      language_hints: ['zh', 'en'],
    },
  };

  console.log(`[asr] → transcribe | model=${ASR_MODEL}`);

  let response;
  try {
    response = await axios.post(
      `${DASHSCOPE_BASE}/api/v1/services/audio/asr/transcription`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
          'X-DashScope-OssResourceResolve': 'enable',
        },
        timeout: 30000,
      }
    );
  } catch (error) {
    const msg = error.response?.data?.message || error.message || 'unknown';
    throw new Error(`ASR 转写任务提交失败：${msg}`);
  }

  const taskId = response.data?.output?.task_id;
  if (!taskId) {
    throw new Error(`ASR 转写任务未返回 task_id：${JSON.stringify(response.data).slice(0, 300)}`);
  }

  console.log(`[asr] task submitted | task_id=${taskId}`);
  return taskId;
}

/**
 * 从 transcription_url 获取实际转写结果 JSON，提取句子时间戳
 *
 * DashScope 录音文件识别的结果不直接在任务查询中返回，
 * 而是通过 transcription_url 指向一份独立的 JSON 文件，格式为：
 *   { file_url, properties, transcripts: [{ channel_id, text, sentences: [...] }] }
 *
 * @param {string} transcriptionUrl
 * @returns {Promise<Array<{ text: string, beginMs: number, endMs: number }>>}
 */
async function fetchTranscriptionSentences(transcriptionUrl) {
  const response = await axios.get(transcriptionUrl, { timeout: 15000 });
  const transcripts = response.data?.transcripts || [];
  const sentences = [];
  for (const transcript of transcripts) {
    const sents = transcript.sentences || [];
    for (const sent of sents) {
      const beginMs = Number(sent.begin_time) || 0;
      const endMs = Number(sent.end_time) || 0;
      if (endMs > beginMs && (sent.text || '').trim()) {
        sentences.push({
          text: String(sent.text || '').trim(),
          beginMs,
          endMs,
        });
      }
    }
  }
  return sentences;
}

/**
 * 轮询转写任务状态，直到完成或失败，然后 fetch transcription_url 获取结果
 *
 * @param {string} taskId
 * @param {string} apiKey
 * @param {number} timeoutMs - 轮询超时（ms）
 * @returns {Promise<Array<{ text: string, beginMs: number, endMs: number }>>} 句子列表
 */
async function pollTranscriptionResult(taskId, apiKey, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) {
      throw new Error(`ASR 转写任务轮询超时（${timeoutMs}ms）`);
    }

    await sleep(POLL_INTERVAL_MS);

    let response;
    try {
      response = await axios.get(`${DASHSCOPE_BASE}/api/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      });
    } catch (error) {
      // 网络错误不中断，继续轮询
      if (attempt < MAX_POLL_ATTEMPTS - 1) {
        console.warn(`[asr] poll attempt ${attempt + 1} failed, retrying...`);
        continue;
      }
      throw new Error(`ASR 轮询请求失败：${error.message}`);
    }

    const status = response.data?.output?.task_status;
    if (status === 'SUCCEEDED') {
      // DashScope 录音文件识别：结果在 transcription_url 中，需二次获取
      const results = response.data?.output?.results || [];
      const allSentences = [];
      for (const result of results) {
        if (result.subtask_status !== 'SUCCEEDED' || !result.transcription_url) {
          console.warn(`[asr] subtask skipped: status=${result.subtask_status}`);
          continue;
        }
        try {
          const sents = await fetchTranscriptionSentences(result.transcription_url);
          allSentences.push(...sents);
        } catch (fetchErr) {
          console.warn(`[asr] fetch transcription_url failed:`, fetchErr.message);
        }
      }
      return allSentences;
    }

    if (status === 'FAILED') {
      const errorMsg = response.data?.output?.message || 'unknown error';
      throw new Error(`ASR 转写任务失败：${errorMsg}`);
    }

    // PENDING / RUNNING — 继续轮询
    if (attempt % 5 === 0) {
      console.log(`[asr] polling... | task_id=${taskId} | status=${status} | attempt=${attempt + 1}`);
    }
  }

  throw new Error(`ASR 转写任务轮询超时（已达最大尝试次数 ${MAX_POLL_ATTEMPTS}）`);
}

/**
 * 主入口：对音频文件执行 ASR，返回句子级时间戳
 *
 * @param {string} audioPath - 音频文件绝对路径
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ sentences: Array<{ text: string, beginMs: number, endMs: number }>, elapsedMs: number }>}
 */
async function transcribeWithTimestamps(audioPath, options = {}) {
  if (!isAsrEnabled()) {
    console.log('[asr] ASR disabled (EMPHASIS_ASR_ENABLED=false), skipping');
    return { sentences: [], elapsedMs: 0, disabled: true };
  }

  const tStart = Date.now();
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY 未配置，无法调用 ASR');
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // 1. 上传音频文件
  const fileUrl = await uploadAudioFile(audioPath, apiKey);

  // 2. 提交转写任务
  const taskId = await submitTranscriptionTask(fileUrl, apiKey);

  // 3. 轮询获取结果
  const sentences = await pollTranscriptionResult(taskId, apiKey, timeoutMs);

  const elapsedMs = Date.now() - tStart;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  console.log(`[asr] ← ${elapsedSec}s | sentences=${sentences.length}`);

  return { sentences, elapsedMs };
}

module.exports = { transcribeWithTimestamps, isAsrEnabled };
