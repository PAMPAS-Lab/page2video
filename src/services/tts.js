/**
 * tts.js — DashScope CosyVoice TTS 调用封装
 *
 * 将讲稿文本合成为语音音频，返回文件路径和时长。
 *
 * 导出：
 *   synthesizeSpeech(text, options) → { audioPath, duration, elapsedMs }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const config = require('../config');

const DASHSCOPE_TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const DEFAULT_MODEL = 'cosyvoice-v3-flash';
const DEFAULT_VOICE = 'longanyang';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 探测音频文件时长（秒）
 * @param {string} audioPath
 * @returns {number}
 */
function probeAudioDuration(audioPath) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration',
       '-of', 'default=noprint_wrappers=1:nokey=1', audioPath],
      { timeout: 10000, encoding: 'utf8' }
    );
    const d = parseFloat(out.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * 从 URL 下载音频文件到本地
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadAudio(url, outputPath) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
  });
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outputPath);
    response.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

/**
 * 调用 CosyVoice TTS 合成语音
 *
 * @param {string} text - 要合成的文本
 * @param {object} [options]
 * @param {string} [options.outputPath] - 输出文件路径（必填）
 * @param {string} [options.model] - TTS 模型
 * @param {string} [options.voice] - 音色
 * @param {string} [options.format] - 音频格式
 * @param {number} [options.sampleRate] - 采样率
 * @param {number} [options.rate] - 语速 (0.5-2.0)
 * @param {number} [options.timeoutMs] - 超时
 * @returns {Promise<{ audioPath: string, duration: number, elapsedMs: number, model: string, voice: string }>}
 */
async function synthesizeSpeech(text, options = {}) {
  const tStart = Date.now();

  if (!text || !text.trim()) {
    throw new Error('TTS: text is required');
  }

  const outputPath = options.outputPath;
  if (!outputPath) {
    throw new Error('TTS: outputPath is required');
  }

  const apiKey = config.getDashScopeApiKey();
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY 未配置，无法调用 TTS');
  }

  const model = options.model || process.env.EMPHASIS_TTS_MODEL || DEFAULT_MODEL;
  const voice = options.voice || process.env.EMPHASIS_TTS_VOICE || DEFAULT_VOICE;
  const format = options.format || DEFAULT_FORMAT;
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const rate = options.rate || 1.0;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  console.log(`[tts] → model=${model} | voice=${voice} | chars=${text.length}`);

  // 调用 CosyVoice API（非流式）
  const payload = {
    model,
    input: {
      text: text.slice(0, 8000), // CosyVoice 文本长度限制
      voice,
      format,
      sample_rate: sampleRate,
    },
  };

  if (rate !== 1.0) {
    payload.input.rate = rate;
  }

  let response;
  try {
    response = await axios.post(DASHSCOPE_TTS_URL, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 500)
      : err.message;
    throw new Error(`TTS API 调用失败：${msg}`);
  }

  const data = response.data;
  const audioUrl = data?.output?.audio?.url;

  if (!audioUrl) {
    // 检查是否有错误信息
    const errMsg = data?.message || data?.output?.message || '未知错误';
    throw new Error(`TTS 合成失败：${errMsg} (response: ${JSON.stringify(data).slice(0, 300)})`);
  }

  // 下载音频文件
  await downloadAudio(audioUrl, outputPath);

  // 探测时长
  const duration = probeAudioDuration(outputPath);

  const elapsedMs = Date.now() - tStart;
  const fileSize = fs.statSync(outputPath).size;
  console.log(
    `[tts] ← ${((elapsedMs) / 1000).toFixed(1)}s | duration=${duration.toFixed(1)}s | size=${(fileSize / 1024).toFixed(1)}KB`
  );

  return {
    audioPath: outputPath,
    duration,
    elapsedMs,
    model,
    voice,
    characters: data?.usage?.characters || text.length,
  };
}

module.exports = {
  synthesizeSpeech,
  probeAudioDuration,
};
