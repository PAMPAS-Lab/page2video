/**
 * config.js — 统一配置中心
 *
 * 集中管理所有环境变量读取和路径解析，消除各服务模块中的硬编码。
 */

'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');

// ── .env 自动加载 ──────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  }
})();

// ── 路径解析 ──────────────────────────────────────────────

function getProjectRoot() {
  return PROJECT_ROOT;
}

function getMediaDir() {
  const envDir = process.env.MEDIA_DIR;
  if (envDir) {
    return path.isAbsolute(envDir) ? envDir : path.join(PROJECT_ROOT, envDir);
  }
  return path.join(PROJECT_ROOT, 'media');
}

function getDataDir() {
  const envDir = process.env.DATA_DIR;
  if (envDir) {
    return path.isAbsolute(envDir) ? envDir : path.join(PROJECT_ROOT, envDir);
  }
  return path.join(PROJECT_ROOT, 'data');
}

function getPromptsDir() {
  return path.join(PROJECT_ROOT, 'config', 'prompts');
}

function getTemplatesDir() {
  return path.join(PROJECT_ROOT, 'config', 'templates');
}

// ── 环境变量读取（带默认值）────────────────────────────────

function getDashScopeApiKey() {
  return process.env.DASHSCOPE_API_KEY || '';
}

function getAggModel() {
  return process.env.EMPHASIS_AGG_MODEL || 'qwen-plus';
}

function getVlmModel() {
  return process.env.EMPHASIS_VLM_MODEL || 'qwen3.6-flash';
}

function getAsrModel() {
  return process.env.EMPHASIS_ASR_MODEL || 'paraformer-v2';
}

function isAsrEnabled() {
  const val = String(process.env.EMPHASIS_ASR_ENABLED || 'true').trim().toLowerCase();
  return val !== 'false' && val !== '0' && val !== 'no';
}

function getAsrTimeoutMs() {
  return Number(process.env.EMPHASIS_ASR_TIMEOUT_MS) || 60000;
}

function getTaskTimeoutMs() {
  return Number(process.env.EMPHASIS_TASK_TIMEOUT_MS) || 60000;
}

function getOcrMode() {
  return process.env.EMPHASIS_OCR_MODE || 'rows';
}

function getOcrAreaThreshold() {
  return Number(process.env.EMPHASIS_OCR_AREA_THRESHOLD) || 0.003;
}

function getRenderTimeoutMs() {
  return Number(process.env.EMPHASIS_RENDER_TIMEOUT_MS) || 0;
}

function getChromePath() {
  return process.env.HYPERFRAMES_CHROME_PATH || '';
}

function getApiKey() {
  return process.env.API_KEY || '';
}

function getPort() {
  return Number(process.env.PORT) || 3200;
}

// ── 凭证加载 ──────────────────────────────────────────────

let cachedAliyunCredentials = null;

function getAliyunCredentials() {
  if (cachedAliyunCredentials) return cachedAliyunCredentials;
  const ak = String(process.env.ALIYUN_ACCESS_KEY_ID || '').trim();
  const sk = String(process.env.ALIYUN_ACCESS_KEY_SECRET || '').trim();
  if (ak && sk) {
    cachedAliyunCredentials = { ak, sk, source: 'env' };
    return cachedAliyunCredentials;
  }
  // 兜底：项目根 .alikey
  const aliKeyPath = path.join(PROJECT_ROOT, '.alikey');
  if (fs.existsSync(aliKeyPath)) {
    const lines = fs.readFileSync(aliKeyPath, 'utf-8').split('\n').map(s => s.trim());
    if (lines[0] && lines[1]) {
      cachedAliyunCredentials = { ak: lines[0], sk: lines[1], source: '.alikey' };
      return cachedAliyunCredentials;
    }
  }
  return null;
}

module.exports = {
  getProjectRoot,
  getMediaDir,
  getDataDir,
  getPromptsDir,
  getTemplatesDir,
  getDashScopeApiKey,
  getAggModel,
  getVlmModel,
  getAsrModel,
  isAsrEnabled,
  getAsrTimeoutMs,
  getTaskTimeoutMs,
  getOcrMode,
  getOcrAreaThreshold,
  getRenderTimeoutMs,
  getChromePath,
  getApiKey,
  getPort,
  getAliyunCredentials,
};
