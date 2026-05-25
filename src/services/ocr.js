/**
 * ocr.js — 阿里云 RecognizeAllText (Type=Advanced) 封装
 *
 * 设计原则：
 *   - 零新依赖（仅 Node 内置 crypto / fetch / fs）
 *   - 凭证读自 config（env ALIYUN_ACCESS_KEY_ID/SECRET 或 .alikey）
 *   - 默认 mode='rows'、areaThreshold=0.003，由 env 覆盖
 *   - 单次失败重试 1 次，超时由 EMPHASIS_TASK_TIMEOUT_MS 控制
 *
 * 导出：
 *   runOcr(imagePath, opts) → { lines, imageSize, stats, mode, elapsedMs, droppedCount }
 *   runOcrRaw(imagePath, opts) → { rawLines, imageSize, requestId, source, elapsedMs }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  processOcrLines,
  DEFAULT_AREA_THRESHOLD,
} = require('../lib/ocrAggregate');
const config = require('../config');

// ── 常量 ────────────────────────────────────────────────
const HOST = 'ocr-api.cn-hangzhou.aliyuncs.com';
const API_VERSION = '2021-07-07';
const ACTION = 'RecognizeAllText';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── 凭证 ────────────────────────────────────────────────

function loadCredentials() {
  const creds = config.getAliyunCredentials();
  if (creds) return creds;
  throw new Error('阿里云 OCR 凭证缺失：未设置 ALIYUN_ACCESS_KEY_ID/SECRET，且 .alikey 不可用');
}

// ── 工具函数 ──────────────────────────────────────────────

function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        const segLen = buf.readUInt16BE(off + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
        }
        off += 2 + segLen;
      }
    }
  } catch (_) { /* ignore */ }
  return { w: 0, h: 0 };
}

function rfc3986Encode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildCanonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join('&');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest('hex');
}

function signRequest({ method, canonicalUri, queryParams, headers, bodyBuffer, ak, sk }) {
  const canonicalQueryString = buildCanonicalQueryString(queryParams);
  const hashedPayload = sha256Hex(bodyBuffer || Buffer.alloc(0));
  headers['x-acs-content-sha256'] = hashedPayload;
  const signedHeaderKeys = Object.keys(headers)
    .map(k => k.toLowerCase())
    .filter(k => k === 'host' || k.startsWith('x-acs-') || k === 'content-type')
    .sort();
  const canonicalHeaders = signedHeaderKeys
    .map(k => {
      const origKey = Object.keys(headers).find(kk => kk.toLowerCase() === k);
      return `${k}:${String(headers[origKey]).trim()}\n`;
    })
    .join('');
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256Hex(sk, stringToSign);
  return `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

// ── 响应解析 ───────────────────────────────────────────────

let _warnedOob = false;
function pointsToBboxNorm(pos, W, H) {
  if (!Array.isArray(pos) || pos.length === 0) return null;
  const xs = pos.map(p => Number(p.X ?? p.x) || 0);
  const ys = pos.map(p => Number(p.Y ?? p.y) || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (!_warnedOob && (maxX > W * 1.05 || maxY > H * 1.05)) {
    _warnedOob = true;
    console.warn(`[ocr] bbox 越界：maxX=${maxX} maxY=${maxY} W=${W} H=${H}`);
  }
  return [minX / W, minY / H, (maxX - minX) / W, (maxY - minY) / H];
}

function normConf(v) {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n > 1 ? n / 100 : n;
}

function extractLinesFromData(data, imgW, imgH) {
  if (!data) return [];
  const W = imgW || Number(data.Width) || 1;
  const H = imgH || Number(data.Height) || 1;
  const subImages = Array.isArray(data.SubImages) ? data.SubImages : [];
  if (process.env.EMPHASIS_OCR_DEBUG === '1') {
    const firstPos = subImages[0]?.BlockInfo?.BlockDetails?.[0]?.BlockPoints
      || subImages[0]?.RowInfo?.RowDetails?.[0]?.RowPoints;
    console.log('[OCR-DEBUG] data.W/H=', data.Width, data.Height, 'imgW/H=', imgW, imgH, 'firstPos=', firstPos);
  }
  const out = [];

  for (const sub of subImages) {
    const rows = sub?.RowInfo?.RowDetails || sub?.RowInfo?.Rows;
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) {
        const pos = r.RowPoints || r.Pos;
        out.push({
          text: r.RowContent || r.Text || '',
          bboxNorm: pointsToBboxNorm(pos, W, H) || [0, 0, 0, 0],
          confidence: normConf(r.RowConfidence ?? r.Confidence),
          _src: 'RowInfo',
        });
      }
    }
  }
  if (out.length) return out;

  for (const sub of subImages) {
    const blocks = sub?.BlockInfo?.BlockDetails || sub?.BlockInfo?.Blocks;
    if (Array.isArray(blocks) && blocks.length) {
      for (const b of blocks) {
        const pos = b.BlockPoints || b.Pos;
        out.push({
          text: b.BlockContent || b.Text || '',
          bboxNorm: pointsToBboxNorm(pos, W, H) || [0, 0, 0, 0],
          confidence: normConf(b.BlockConfidence ?? b.Confidence),
          _src: 'BlockInfo',
        });
      }
    }
  }
  return out;
}

// ── 单次请求 ─────────────────────────────────────────────

async function callAliyunOcr(absPath, timeoutMs) {
  const { ak, sk } = loadCredentials();
  const bodyBuffer = fs.readFileSync(absPath);
  if (bodyBuffer.length > MAX_BODY_BYTES) {
    throw new Error(`图片过大 ${(bodyBuffer.length / 1024 / 1024).toFixed(2)}MB > 10MB`);
  }
  const queryParams = {
    Type: 'Advanced',
    OutputCoordinate: 'points',
    OutputOricoord: 'true',
    'AdvancedConfig.OutputRow': 'true',
  };
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = {
    host: HOST,
    'x-acs-action': ACTION,
    'x-acs-version': API_VERSION,
    'x-acs-date': nowIso,
    'x-acs-signature-nonce': nonce,
    'content-type': 'application/octet-stream',
  };
  headers.Authorization = signRequest({
    method: 'POST',
    canonicalUri: '/',
    queryParams,
    headers,
    bodyBuffer,
    ak,
    sk,
  });
  const url = `https://${HOST}/?${buildCanonicalQueryString(queryParams)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyBuffer,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new Error(`响应非 JSON：${text.slice(0, 200)}`);
    }
    if (json.Code && json.Code !== 'OK') {
      throw new Error(`API Code=${json.Code} Message=${json.Message || ''} RequestId=${json.RequestId || ''}`);
    }
    let data = json.Data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { /* keep */ }
    }
    return { data, requestId: json.RequestId || null };
  } finally {
    clearTimeout(timer);
  }
}

// ── 公共入口 ───────────────────────────────────────────

async function runOcr(imagePath, opts = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(`图片不存在：${imagePath}`);
  }
  const tStart = Date.now();
  const imageSize = getImageSize(imagePath);
  const timeoutMs = Number(opts.timeoutMs) || config.getTaskTimeoutMs();

  const mode = opts.mode || config.getOcrMode();
  const areaThreshold = Number.isFinite(opts.areaThreshold)
    ? Number(opts.areaThreshold)
    : config.getOcrAreaThreshold();

  let lastErr = null;
  let apiResp = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      apiResp = await callAliyunOcr(imagePath, timeoutMs);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  if (!apiResp) {
    throw new Error(`阿里云 OCR 调用失败：${lastErr?.message || lastErr}`);
  }

  const rawLines = extractLinesFromData(apiResp.data, imageSize.w, imageSize.h);
  const processed = processOcrLines(rawLines, opts.vlmBlocks || [], {
    mode,
    areaThreshold,
  });

  return {
    lines: processed.kept,
    imageSize: {
      w: imageSize.w || Number(apiResp.data?.Width) || 0,
      h: imageSize.h || Number(apiResp.data?.Height) || 0,
    },
    stats: processed.stats,
    mode: processed.mode,
    droppedCount: processed.dropped.length,
    elapsedMs: Date.now() - tStart,
    requestId: apiResp.requestId,
    source: rawLines[0]?._src || 'empty',
  };
}

async function runOcrRaw(imagePath, opts = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(`图片不存在：${imagePath}`);
  }
  const tStart = Date.now();
  const imageSize = getImageSize(imagePath);
  const timeoutMs = Number(opts.timeoutMs) || config.getTaskTimeoutMs();

  let lastErr = null;
  let apiResp = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      apiResp = await callAliyunOcr(imagePath, timeoutMs);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!apiResp) {
    throw new Error(`阿里云 OCR 调用失败：${lastErr?.message || lastErr}`);
  }

  const rawLines = extractLinesFromData(apiResp.data, imageSize.w, imageSize.h);
  return {
    rawLines,
    imageSize: {
      w: imageSize.w || Number(apiResp.data?.Width) || 0,
      h: imageSize.h || Number(apiResp.data?.Height) || 0,
    },
    requestId: apiResp.requestId,
    source: rawLines[0]?._src || 'empty',
    elapsedMs: Date.now() - tStart,
  };
}

module.exports = {
  runOcr,
  runOcrRaw,
  _internal: {
    extractLinesFromData,
    signRequest,
    loadCredentials,
    getImageSize,
  },
};
