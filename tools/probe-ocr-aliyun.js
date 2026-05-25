#!/usr/bin/env node

/**
 * probe-ocr-aliyun.js — 阿里云 OCR RecognizeAllText API 探针
 *
 * 直连阿里云 OCR API（Version 2021-07-07, Action RecognizeAllText, Type=Advanced），
 * 使用 RAM 子账号 AK/SK（读自 .alikey 前两行）+ ACS3-HMAC-SHA256 签名。
 * 无新依赖，仅用 Node 内置 crypto / fetch。
 *
 * 用法：
 *   node tools/probe-ocr-aliyun.js <path-to-png>
 *
 * 产物：
 *   tools/output/<ts>-aliyun-ocr-<page>.json
 *     {
 *       ok, elapsedMs, imagePath, imageSize,
 *       lines: [{ text, bboxNorm:[x,y,w,h], points:[[x,y]x4], confidence }],
 *       rawResponse: <完整原始响应>
 *     }
 *
 * 设计原则（无损可回滚）：
 *   - 独立脚本，不改任何既有文件
 *   - 无新 npm 依赖，只用 Node 内置模块
 *   - 删除该脚本与其产物即完全回滚
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('./lib/envLoader');

// ── 常量 ────────────────────────────────────────────────
const HOST = 'ocr-api.cn-hangzhou.aliyuncs.com';
const API_VERSION = '2021-07-07';
const ACTION = 'RecognizeAllText';

// ── helpers ────────────────────────────────────────────

function loadCredentials() {
  const aliKeyPath = path.join(__dirname, '..', '.alikey');
  if (!fs.existsSync(aliKeyPath)) {
    throw new Error(`凭证文件不存在：${aliKeyPath}（应在项目根）`);
  }
  const lines = fs.readFileSync(aliKeyPath, 'utf-8').split('\n').map(s => s.trim());
  const ak = lines[0];
  const sk = lines[1];
  if (!ak || !sk) throw new Error('.alikey 前两行必须为 AK / SK');
  return { ak, sk };
}

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
    return { w: 0, h: 0 };
  } catch (_) {
    return { w: 0, h: 0 };
  }
}

// RFC3986 严格 URI 编码（encodeURIComponent 不够）
function rfc3986Encode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildCanonicalQueryString(params) {
  const keys = Object.keys(params).sort();
  return keys
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join('&');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest('hex');
}

/**
 * 构建 ACS3-HMAC-SHA256 Authorization 头
 * 参考：https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 */
function signRequest({ method, canonicalUri, queryParams, headers, bodyBuffer, ak, sk }) {
  const canonicalQueryString = buildCanonicalQueryString(queryParams);

  // HashedRequestPayload（body 二进制 sha256）
  const hashedPayload = sha256Hex(bodyBuffer || Buffer.alloc(0));
  headers['x-acs-content-sha256'] = hashedPayload;

  // CanonicalHeaders：仅包含参与签名的 headers（建议除 Authorization 外全部），小写 key 字典序
  const signedHeaderKeys = Object.keys(headers)
    .map(k => k.toLowerCase())
    .filter(k => k === 'host' || k.startsWith('x-acs-') || k === 'content-type')
    .sort();
  const canonicalHeaders = signedHeaderKeys
    .map(k => {
      // 找到原始 key（大小写不敏感）
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

  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;
  const signature = hmacSha256Hex(sk, stringToSign);

  const authorization = `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { authorization, canonicalRequest, stringToSign };
}

// ── 解析响应：把 Data 抽出为统一 lines 数组 ───────────────────

/**
 * 阿里云 OCR Advanced 实测返回结构：
 *   Data: {
 *     Width, Height, Content, SubImageCount,
 *     SubImages: [{
 *       SubImageId, Type, Angle, SubImagePoints:[{X,Y}x4],
 *       BlockInfo: {
 *         BlockCount,
 *         BlockDetails: [{ BlockId, BlockContent, BlockAngle, BlockConfidence(0-100), BlockPoints:[{X,Y}x4] }]
 *       },
 *       // OutputRow=true 且作为 AdvancedConfig 时可能额外返回 RowInfo
 *       RowInfo?: { RowCount, RowDetails:[{ RowId, RowContent, RowConfidence(0-100), RowPoints:[{X,Y}x4] }] }
 *     }]
 *   }
 *
 * 优先级：RowInfo.RowDetails > BlockInfo.BlockDetails
 */
function extractLinesFromData(data, imgW, imgH) {
  if (!data) return [];
  const W = Number(data.Width) || imgW || 1;
  const H = Number(data.Height) || imgH || 1;

  const pointsToBboxNorm = (pos) => {
    if (!Array.isArray(pos) || pos.length === 0) return null;
    const xs = pos.map(p => Number(p.X ?? p.x) || 0);
    const ys = pos.map(p => Number(p.Y ?? p.y) || 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return [minX / W, minY / H, (maxX - minX) / W, (maxY - minY) / H];
  };
  const pointsToArray = (pos) => {
    if (!Array.isArray(pos)) return [];
    return pos.map(p => [Number(p.X ?? p.x) || 0, Number(p.Y ?? p.y) || 0]);
  };
  const normConf = (v) => {
    if (v == null) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n > 1 ? n / 100 : n;
  };

  const subImages = Array.isArray(data.SubImages) ? data.SubImages : [];
  const out = [];

  // 优先 RowInfo（行级）
  for (const sub of subImages) {
    const rows = sub?.RowInfo?.RowDetails || sub?.RowInfo?.Rows;
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) {
        const pos = r.RowPoints || r.Pos;
        out.push({
          text: r.RowContent || r.Text || '',
          bboxNorm: pointsToBboxNorm(pos) || [0, 0, 0, 0],
          points: pointsToArray(pos),
          confidence: normConf(r.RowConfidence ?? r.Confidence),
          _src: 'RowInfo',
          _subId: sub.SubImageId ?? 0,
          _idx: r.RowId ?? out.length,
        });
      }
    }
  }
  if (out.length) return out;

  // 退化到 Block 级（实测默认就是这层）
  for (const sub of subImages) {
    const blocks = sub?.BlockInfo?.BlockDetails || sub?.BlockInfo?.Blocks;
    if (Array.isArray(blocks) && blocks.length) {
      for (const b of blocks) {
        const pos = b.BlockPoints || b.Pos;
        out.push({
          text: b.BlockContent || b.Text || '',
          bboxNorm: pointsToBboxNorm(pos) || [0, 0, 0, 0],
          points: pointsToArray(pos),
          confidence: normConf(b.BlockConfidence ?? b.Confidence),
          _src: 'BlockInfo',
          _subId: sub.SubImageId ?? 0,
          _idx: b.BlockId ?? out.length,
        });
      }
    }
  }
  return out;
}

// ── main ──────────────────────────────────────────────

async function main() {
  const pngPath = process.argv[2];
  if (!pngPath) {
    console.error('用法：node tools/probe-ocr-aliyun.js <path-to-png>');
    process.exit(1);
  }
  const absPath = path.resolve(pngPath);
  if (!fs.existsSync(absPath)) {
    console.error(`文件不存在：${absPath}`);
    process.exit(1);
  }

  const { ak, sk } = loadCredentials();
  const imageSize = getImageSize(absPath);
  const bodyBuffer = fs.readFileSync(absPath);

  console.log(`📷 图片：${absPath}`);
  console.log(`   尺寸：${imageSize.w} × ${imageSize.h}   大小：${(bodyBuffer.length / 1024).toFixed(1)} KB`);
  console.log(`🔑 RAM AK：${ak.slice(0, 6)}…${ak.slice(-4)}`);

  if (bodyBuffer.length > 10 * 1024 * 1024) {
    throw new Error(`图片过大 ${(bodyBuffer.length / 1024 / 1024).toFixed(2)}MB，API 上限 10MB`);
  }

  // ── 查询参数（通用文字识别高精版 + 四点坐标 + 原图坐标 + 行级聚合）
  // 注：OutputRow 是 AdvancedConfig 下的子参数，用点号拆为扁平 query key
  const queryParams = {
    Type: 'Advanced',
    OutputCoordinate: 'points',
    OutputOricoord: 'true',
    'AdvancedConfig.OutputRow': 'true',
  };

  // ── 请求头
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); // yyyy-MM-ddTHH:mm:ssZ
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = {
    'host': HOST,
    'x-acs-action': ACTION,
    'x-acs-version': API_VERSION,
    'x-acs-date': nowIso,
    'x-acs-signature-nonce': nonce,
    'content-type': 'application/octet-stream',
  };

  // ── 签名
  const { authorization } = signRequest({
    method: 'POST',
    canonicalUri: '/',
    queryParams,
    headers,
    bodyBuffer,
    ak,
    sk,
  });
  headers.Authorization = authorization;

  // ── 发送
  const qs = buildCanonicalQueryString(queryParams);
  const url = `https://${HOST}/?${qs}`;
  console.log(`🚀 POST ${url}`);

  const tStart = Date.now();
  let responseText = '';
  let responseJson = null;
  let httpStatus = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyBuffer,
    });
    httpStatus = res.status;
    responseText = await res.text();
    try { responseJson = JSON.parse(responseText); } catch (_) {}
  } catch (err) {
    const elapsedMs = Date.now() - tStart;
    console.error(`❌ 请求失败 (${elapsedMs}ms)：${err.message}`);
    process.exit(2);
  }
  const elapsedMs = Date.now() - tStart;

  if (httpStatus !== 200 || !responseJson) {
    console.error(`❌ HTTP ${httpStatus} (${elapsedMs}ms)`);
    console.error(`   响应预览：${responseText.slice(0, 600)}`);
    process.exit(2);
  }

  // 阿里云响应：成功时包含 Data；失败时含 Code/Message
  if (responseJson.Code && responseJson.Code !== 'OK') {
    console.error(`❌ API 返回错误 Code=${responseJson.Code}  Message=${responseJson.Message}`);
    console.error(`   RequestId=${responseJson.RequestId || ''}`);
    process.exit(2);
  }

  // 阿里云 OCR: Data 字段可能是 JSON 字符串（Advanced 型），需要再次 parse
  let data = responseJson.Data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) {}
  }

  const lines = extractLinesFromData(data, imageSize.w, imageSize.h);
  const srcTag = lines[0]?._src || 'empty';

  console.log(`✅ HTTP 200  (${elapsedMs}ms)   RequestId=${responseJson.RequestId || ''}`);
  console.log(`   解析来源：${srcTag}`);
  console.log(`   识别行数：${lines.length}`);
  console.log(`   响应原图尺寸：${data?.Width || '?'} × ${data?.Height || '?'}`);
  if (lines.length) {
    console.log(`   文字行预览：`);
    for (const l of lines.slice(0, 10)) {
      const conf = l.confidence != null ? l.confidence.toFixed(2) : 'N/A';
      console.log(`     [${conf}] ${(l.text || '').slice(0, 60)}${(l.text || '').length > 60 ? '…' : ''}  bbox=[${l.bboxNorm.map(v => v.toFixed(3)).join(',')}]`);
    }
    if (lines.length > 10) console.log(`     … 共 ${lines.length} 行`);
  }

  // 保存
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = path.basename(absPath, path.extname(absPath));
  const outPath = path.join(outDir, `${ts}-aliyun-ocr-${baseName}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    ok: true,
    api: `aliyun/${ACTION}/${API_VERSION}`,
    endpoint: HOST,
    imagePath: absPath,
    imageSize,
    responseImageSize: { w: data?.Width || null, h: data?.Height || null },
    queryParams,
    elapsedMs,
    requestId: responseJson.RequestId || null,
    lineSource: srcTag,
    lines,
    rawData: data, // 保留完整 Data 以便调试（包含原始 Blocks / Words / Rows）
  }, null, 2), 'utf-8');

  console.log(`\n📄 结果已保存：${outPath}`);
  console.log(`👉 叠加到可视化：node tools/visualize-vlm-blocks.js <png> --ocr ${outPath}`);
}

main().catch(err => {
  console.error('fatal:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
