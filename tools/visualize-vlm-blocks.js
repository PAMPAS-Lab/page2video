#!/usr/bin/env node

/**
 * visualize-vlm-blocks.js — VLM 区块识别结果可视化（临时调试工具）
 *
 * 目的：把 VLM 识别出的全部 bbox 框叠加到原始幻灯片截图上，
 *      生成一个独立 HTML 报告，浏览器打开后人工判断分割准确性。
 *
 * 用法：
 *   1) 实时调用 VLM：
 *      node tools/visualize-vlm-blocks.js <path-to-png>
 *
 *   2) 复用已有 VLM probe 结果：
 *      node tools/visualize-vlm-blocks.js --from-json <path-to-vlm-probe.json>
 *
 *   3) 叠加 OCR 文本定位层（任一模式均可追加）：
 *      node tools/visualize-vlm-blocks.js <png> --ocr <path-to-aliyun-ocr-probe.json>
 *      node tools/visualize-vlm-blocks.js --from-json <vlm.json> --ocr <ocr.json>
 *
 *   4) 仅展示 OCR（不跑 VLM）：
 *      node tools/visualize-vlm-blocks.js <png> --ocr <ocr.json> --no-vlm
 *
 * 产物：tools/output/<ts>-vlm-vis.html
 *       打开即可看见原图 + VLM 区块（粗实线）+ OCR 文字行（细虚线）同屏对比
 *
 * 设计原则（无损可回滚）：
 *   - 完全独立脚本，不引入任何新依赖、不修改既有文件
 *   - 调用相同的 vlmBlockDetect.txt prompt 与 EMPHASIS_VLM_MODEL，输出与 probe 一致
 *   - 图片以 base64 嵌入 HTML，单文件可直接分享
 *   - 删除该脚本与产物即完全回滚
 */

const fs = require('fs');
const path = require('path');
require('./lib/envLoader');
const { normalizeVlmResult, QWEN_CANVAS } = require('../src/lib/qwenBbox');
const { processOcrLines, DEFAULT_AREA_THRESHOLD } = require('../src/lib/ocrAggregate');

// ── helpers (与 probe-vlm-blocks 对齐，独立实现避免耦合) ───────────────

function imageToBase64DataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${b64}`;
}

function getImageSize(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // PNG
    if (buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG (简易扫描 SOF0/SOF2)
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

async function callDashScope(model, messages, temperature = 0.2) {
  const timeoutMs = Number(process.env.EMPHASIS_TASK_TIMEOUT_MS) || 60000;
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未设置，请在 .env 中配置');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, temperature, messages }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonContent(content) {
  try { return JSON.parse(content); } catch (_) {}
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }
  return null;
}

// 不同 kind 用不同颜色（VLM 区块层）
const KIND_COLORS = {
  image:   '#2563eb', // 蓝
  chart:   '#16a34a', // 绿
  table:   '#ea580c', // 橙
  formula: '#dc2626', // 红
  diagram: '#9333ea', // 紫
  other:   '#6b7280', // 灰
};

// OCR 图层统一用青色（区别于 VLM 的彩色）
const OCR_COLOR = '#0891b2'; // 深青
const OCR_COLOR_LOW = '#67e8f9'; // 浅青（低置信度）
const OCR_DROP_COLOR = '#9ca3af'; // 灰（被过滤掉的）

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml({ imageDataUri, imageSize, blocks, ocrLines = [], ocrDropped = [], ocrStats = null, ocrMode = 'raw', meta }) {
  const boxesHtml = blocks.map((b, i) => {
    const [x, y, w, h] = (b.bboxNorm || [0, 0, 0, 0]).map(v => Number(v) || 0);
    // 越界标识来自规范化随身诊断字段（原始 bbox_2d 超出画布）
    const overflow = !!b._bboxOverflow || !!b._bboxIssue;
    const color = KIND_COLORS[b.kind] || KIND_COLORS.other;
    const left = (x * 100).toFixed(3);
    const top = (y * 100).toFixed(3);
    const width = (w * 100).toFixed(3);
    const height = (h * 100).toFixed(3);
    const labelText = `#${i + 1} ${b.id || ''} · ${b.kind || '?'} · ${(Number(b.confidence) || 0).toFixed(2)}`;
    return `
      <div class="box" data-idx="${i}" style="
        left:${left}%; top:${top}%; width:${width}%; height:${height}%;
        border:3px ${overflow ? 'dashed' : 'solid'} ${color};
        box-shadow: 0 0 0 1px rgba(255,255,255,0.6) inset;
      ">
        <div class="label" style="background:${color};">${escapeHtml(labelText)}</div>
      </div>`;
  }).join('\n');

  const listHtml = blocks.map((b, i) => {
    const color = KIND_COLORS[b.kind] || KIND_COLORS.other;
    const [x, y, w, h] = (b.bboxNorm || [0, 0, 0, 0]).map(v => Number(v) || 0);
    const overflow = !!b._bboxOverflow;
    const rawSrc = b._bboxRaw ? b._bboxRaw.source : '?';
    const rawVal = b._bboxRaw ? JSON.stringify(b._bboxRaw.value) : '—';
    const flags = [
      overflow ? '<span class="warn">越界</span>' : '',
      b._bboxSwapped ? '<span class="warn">角点颠倒</span>' : '',
      b._bboxNote ? `<span class="note">${escapeHtml(b._bboxNote)}</span>` : '',
      b._bboxIssue ? `<span class="warn">${escapeHtml(b._bboxIssue)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `
      <tr data-idx="${i}">
        <td><span class="dot" style="background:${color};"></span>#${i + 1}</td>
        <td>${escapeHtml(b.id || '')}</td>
        <td>${escapeHtml(b.kind || '')}</td>
        <td>${(Number(b.confidence) || 0).toFixed(2)}</td>
        <td><code>${escapeHtml(rawSrc)}<br>${escapeHtml(rawVal)}</code></td>
        <td><code>[${[x, y, w, h].map(v => v.toFixed(3)).join(', ')}]</code> ${flags}</td>
        <td>${escapeHtml(b.description || '')}</td>
      </tr>`;
  }).join('\n');

  // ── OCR 图层（第二层：细虚线、青色）──
  const ocrBoxesHtml = ocrLines.map((l, i) => {
    const [x, y, w, h] = (l.bboxNorm || [0, 0, 0, 0]).map(v => Number(v) || 0);
    const left = (x * 100).toFixed(3);
    const top = (y * 100).toFixed(3);
    const width = (w * 100).toFixed(3);
    const height = (h * 100).toFixed(3);
    const conf = l.confidence == null ? null : Number(l.confidence);
    const color = (conf != null && conf < 0.8) ? OCR_COLOR_LOW : OCR_COLOR;
    const mergedInfo = l._mergedFrom ? ` · 合${l._mergedFrom}块` : '';
    const title = `#o${i + 1} ${(l.text || '').slice(0, 40)}${(l.text || '').length > 40 ? '…' : ''} · ${conf != null ? conf.toFixed(2) : 'N/A'}${mergedInfo}`;
    return `
      <div class="ocr-box" data-oidx="${i}" title="${escapeHtml(title)}" style="
        left:${left}%; top:${top}%; width:${width}%; height:${height}%;
        border:1.5px dashed ${color};
      "></div>`;
  }).join('\n');

  // ── 被过滤掉的 OCR（灰色点线，低透明度、仅调试可见）──
  const ocrDroppedBoxesHtml = ocrDropped.map((l, i) => {
    const [x, y, w, h] = (l.bboxNorm || [0, 0, 0, 0]).map(v => Number(v) || 0);
    const left = (x * 100).toFixed(3);
    const top = (y * 100).toFixed(3);
    const width = (w * 100).toFixed(3);
    const height = (h * 100).toFixed(3);
    const title = `#d${i + 1} ${(l.text || '').slice(0, 40)} · ${l._dropReason || ''}`;
    return `
      <div class="ocr-drop-box" data-didx="${i}" title="${escapeHtml(title)}" style="
        left:${left}%; top:${top}%; width:${width}%; height:${height}%;
      "></div>`;
  }).join('\n');

  const ocrListHtml = ocrLines.map((l, i) => {
    const conf = l.confidence == null ? 'N/A' : Number(l.confidence).toFixed(2);
    const [x, y, w, h] = (l.bboxNorm || [0, 0, 0, 0]).map(v => Number(v) || 0);
    const tag = l._mergedFrom ? `<span class="tag">合${l._mergedFrom}</span>` : '';
    return `
      <tr data-oidx="${i}">
        <td>#o${i + 1} ${tag}</td>
        <td>${conf}</td>
        <td class="ocr-text">${escapeHtml(l.text || '')}</td>
        <td><code>[${[x, y, w, h].map(v => v.toFixed(3)).join(', ')}]</code></td>
      </tr>`;
  }).join('\n');

  const ocrStatsHtml = ocrStats ? `
      <div class="stats">
        <code>mode=${escapeHtml(ocrMode)}</code>
        · 原始 <b>${ocrStats.inputCount}</b>
        → 面积过滤后 <b>${ocrStats.afterArea}</b>
        → VLM 过滤后 <b>${ocrStats.afterVlmOverlap}</b>
        → 最终 <b class="hl">${ocrStats.finalCount}</b>
      </div>
    ` : '';

  const metaJson = escapeHtml(JSON.stringify(meta, null, 2));

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>VLM Blocks Visualization · ${escapeHtml(path.basename(meta.imagePath || ''))}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", "PingFang SC", sans-serif; background: #f5f5f7; color: #1d1d1f; }
  header { padding: 12px 20px; background: #fff; border-bottom: 1px solid #e5e5ea; position: sticky; top: 0; z-index: 100; }
  header h1 { margin: 0 0 4px; font-size: 16px; }
  header .meta { font-size: 12px; color: #6b7280; }
  .toolbar { padding: 8px 20px; background: #fff; border-bottom: 1px solid #e5e5ea; font-size: 13px; }
  .toolbar label { margin-right: 16px; cursor: pointer; user-select: none; }
  .container { display: flex; gap: 16px; padding: 16px 20px; align-items: flex-start; }
  .stage-wrap { flex: 1 1 auto; min-width: 0; }
  .stage { position: relative; display: inline-block; max-width: 100%; background: #000; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .stage img { display: block; max-width: 100%; height: auto; }
  .box { position: absolute; pointer-events: auto; transition: opacity 0.15s; }
  .box .label {
    position: absolute; left: 0; top: -22px;
    color: #fff; font-size: 11px; padding: 2px 6px; line-height: 18px; height: 22px;
    white-space: nowrap; font-family: ui-monospace, Menlo, monospace;
    border-radius: 2px 2px 0 0;
  }
  .box.dim { opacity: 0.15; }
  .box.hide { display: none; }
  .ocr-box { position: absolute; pointer-events: auto; background: transparent; transition: opacity 0.15s; }
  .ocr-box:hover { background: rgba(8,145,178,0.15); }
  .ocr-box.dim { opacity: 0.1; }
  .ocr-box.hide { display: none; }
  .ocr-drop-box { position: absolute; pointer-events: auto; background: transparent;
    border: 1px dotted ${OCR_DROP_COLOR}; opacity: 0.5; }
  .ocr-drop-box:hover { background: rgba(156,163,175,0.2); opacity: 1; }
  .ocr-drop-box.hide { display: none; }
  .sidebar { flex: 0 0 460px; max-height: calc(100vh - 110px); overflow-y: auto; background: #fff; border: 1px solid #e5e5ea; border-radius: 6px; padding: 12px; font-size: 12px; }
  .sidebar section + section { margin-top: 18px; padding-top: 12px; border-top: 2px solid #e5e5ea; }
  .ocr-text { max-width: 180px; word-break: break-all; font-size: 11px; }
  .tag { display: inline-block; background: #dbeafe; color: #1e40af; font-size: 10px; padding: 0 4px; border-radius: 2px; margin-left: 2px; }
  .stats { margin: 8px 0; padding: 8px; background: #f9fafb; border-left: 3px solid ${OCR_COLOR}; font-size: 11px; line-height: 1.6; }
  .stats code { background: #e5e7eb; padding: 1px 4px; border-radius: 2px; font-size: 10px; }
  .stats b { color: #1f2937; }
  .stats b.hl { color: ${OCR_COLOR}; font-size: 13px; }
  .sidebar h3 { margin: 0 0 8px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #f0f0f5; text-align: left; vertical-align: top; }
  th { background: #fafafa; font-weight: 600; font-size: 11px; color: #6b7280; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #374151; word-break: break-all; }
  .note { color: #2563eb; font-size: 10px; }
  tr { cursor: pointer; }
  tr:hover { background: #f0f9ff; }
  tr.active { background: #fef3c7; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .warn { color: #dc2626; font-weight: 600; }
  details.raw { margin-top: 12px; }
  details.raw pre { font-size: 11px; background: #f5f5f7; padding: 8px; border-radius: 4px; overflow-x: auto; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 11px; }
  .legend span { display: inline-flex; align-items: center; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; border-radius: 2px; }
</style>
</head>
<body>
  <header>
    <h1>VLM 区块识别可视化 · ${escapeHtml(path.basename(meta.imagePath || ''))}</h1>
    <div class="meta">
      模型 ${escapeHtml(meta.model || '?')} · 坐标系 ${escapeHtml(meta.coordinateSystem || `qwen-${QWEN_CANVAS}-bbox_2d`)} ·
      图片 ${imageSize.w}×${imageSize.h} ·
      识别 ${blocks.length} 个区块 · 用时 ${meta.elapsedMs || 0}ms
    </div>
    <div class="legend">
      ${Object.entries(KIND_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('')}
      <span style="margin-left:12px"><i style="background:#fff;border:2px dashed #dc2626"></i>VLM 越界</span>
      <span style="margin-left:12px"><i style="background:#fff;border:1.5px dashed ${OCR_COLOR}"></i>OCR 行框</span>
      <span><i style="background:#fff;border:1.5px dashed ${OCR_COLOR_LOW}"></i>OCR 低置信</span>
    </div>
  </header>
  <div class="toolbar">
    <label><input type="checkbox" id="toggle-vlm" checked> 显示 VLM 区块（${blocks.length}）</label>
    <label><input type="checkbox" id="toggle-ocr" ${ocrLines.length ? 'checked' : ''} ${ocrLines.length ? '' : 'disabled'}> 显示 OCR 文字行（${ocrLines.length}）</label>
    ${ocrDropped.length ? `<label><input type="checkbox" id="toggle-dropped"> 显示被过滤的 OCR（${ocrDropped.length}）</label>` : ''}
    <label><input type="checkbox" id="dim-mode"> 仅高亮悬停项（其他变淡）</label>
    <span style="color:#9ca3af">提示：点击右侧表格行可定位框</span>
  </div>
  <div class="container">
    <div class="stage-wrap">
      <div class="stage" id="stage">
        <img src="${imageDataUri}" alt="slide">
        <div id="ocr-drop-layer" style="display:none">${ocrDroppedBoxesHtml}</div>
        <div id="vlm-layer">${boxesHtml}</div>
        <div id="ocr-layer">${ocrBoxesHtml}</div>
      </div>
    </div>
    <aside class="sidebar">
      ${ocrStatsHtml}
      <section>
        <h3>🎯 VLM 区块（${blocks.length}）</h3>
        <table>
          <thead><tr><th>#</th><th>id</th><th>kind</th><th>conf</th><th>原始 bbox</th><th>bboxNorm</th><th>description</th></tr></thead>
          <tbody id="vlm-tbody">${listHtml}</tbody>
        </table>
      </section>
      ${ocrLines.length ? `<section>
        <h3>📝 OCR 文字行（${ocrLines.length}）</h3>
        <table>
          <thead><tr><th>#</th><th>conf</th><th>text</th><th>bboxNorm</th></tr></thead>
          <tbody id="ocr-tbody">${ocrListHtml}</tbody>
        </table>
      </section>` : ''}
      <details class="raw">
        <summary>原始 meta（JSON）</summary>
        <pre>${metaJson}</pre>
      </details>
    </aside>
  </div>
<script>
  const stage = document.getElementById('stage');
  const vlmBoxes = stage.querySelectorAll('.box');
  const ocrBoxes = stage.querySelectorAll('.ocr-box');
  const vlmRows = document.querySelectorAll('#vlm-tbody tr');
  const ocrRows = document.querySelectorAll('#ocr-tbody tr');
  const toggleVlm = document.getElementById('toggle-vlm');
  const toggleOcr = document.getElementById('toggle-ocr');
  const dimMode = document.getElementById('dim-mode');

  toggleVlm.addEventListener('change', () => {
    vlmBoxes.forEach(b => b.classList.toggle('hide', !toggleVlm.checked));
  });
  if (toggleOcr) toggleOcr.addEventListener('change', () => {
    ocrBoxes.forEach(b => b.classList.toggle('hide', !toggleOcr.checked));
  });
  const toggleDropped = document.getElementById('toggle-dropped');
  const dropLayer = document.getElementById('ocr-drop-layer');
  if (toggleDropped && dropLayer) {
    toggleDropped.addEventListener('change', () => {
      dropLayer.style.display = toggleDropped.checked ? '' : 'none';
    });
  }

  function clearActive() {
    vlmBoxes.forEach(b => b.classList.remove('dim'));
    ocrBoxes.forEach(b => b.classList.remove('dim'));
    vlmRows.forEach(r => r.classList.remove('active'));
    ocrRows.forEach(r => r.classList.remove('active'));
  }

  function setActiveVlm(idx) {
    clearActive();
    if (idx == null) return;
    if (dimMode.checked) {
      vlmBoxes.forEach(b => { if (Number(b.dataset.idx) !== idx) b.classList.add('dim'); });
      ocrBoxes.forEach(b => b.classList.add('dim'));
    }
    const row = document.querySelector('#vlm-tbody tr[data-idx="' + idx + '"]');
    const box = document.querySelector('.box[data-idx="' + idx + '"]');
    if (row) row.classList.add('active');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
  function setActiveOcr(idx) {
    clearActive();
    if (idx == null) return;
    if (dimMode.checked) {
      ocrBoxes.forEach(b => { if (Number(b.dataset.oidx) !== idx) b.classList.add('dim'); });
      vlmBoxes.forEach(b => b.classList.add('dim'));
    }
    const row = document.querySelector('#ocr-tbody tr[data-oidx="' + idx + '"]');
    const box = document.querySelector('.ocr-box[data-oidx="' + idx + '"]');
    if (row) row.classList.add('active');
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  vlmRows.forEach(r => {
    r.addEventListener('mouseenter', () => setActiveVlm(Number(r.dataset.idx)));
    r.addEventListener('mouseleave', clearActive);
    r.addEventListener('click', () => setActiveVlm(Number(r.dataset.idx)));
  });
  vlmBoxes.forEach(b => {
    b.addEventListener('mouseenter', () => setActiveVlm(Number(b.dataset.idx)));
    b.addEventListener('mouseleave', clearActive);
  });
  ocrRows.forEach(r => {
    r.addEventListener('mouseenter', () => setActiveOcr(Number(r.dataset.oidx)));
    r.addEventListener('mouseleave', clearActive);
    r.addEventListener('click', () => setActiveOcr(Number(r.dataset.oidx)));
  });
  ocrBoxes.forEach(b => {
    b.addEventListener('mouseenter', () => setActiveOcr(Number(b.dataset.oidx)));
    b.addEventListener('mouseleave', clearActive);
  });
</script>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const fromJsonIdx = args.indexOf('--from-json');
  const fromJsonPath = fromJsonIdx >= 0 ? args[fromJsonIdx + 1] : null;
  const ocrIdx = args.indexOf('--ocr');
  const ocrJsonPath = ocrIdx >= 0 ? args[ocrIdx + 1] : null;
  const noVlm = args.includes('--no-vlm');

  // OCR 后处理参数
  const ocrModeIdx = args.indexOf('--ocr-mode');
  const ocrMode = ocrModeIdx >= 0 ? args[ocrModeIdx + 1] : 'rows'; // raw | filter | rows
  const areaThrIdx = args.indexOf('--area-threshold');
  const areaThreshold = areaThrIdx >= 0 ? Number(args[areaThrIdx + 1]) : DEFAULT_AREA_THRESHOLD;

  if (!['raw', 'filter', 'rows'].includes(ocrMode)) {
    console.error(`--ocr-mode 只能为 raw|filter|rows，当前：${ocrMode}`);
    process.exit(1);
  }

  const inputPath = fromJsonPath ? null : args.find((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = args[i - 1];
    return prev !== '--from-json' && prev !== '--ocr' && prev !== '--ocr-mode' && prev !== '--area-threshold';
  });

  if (!inputPath && !fromJsonPath) {
    console.error('用法：');
    console.error('  node tools/visualize-vlm-blocks.js <path-to-png> [--ocr <ocr.json>] [--ocr-mode raw|filter|rows] [--area-threshold 0.003] [--no-vlm]');
    console.error('  node tools/visualize-vlm-blocks.js --from-json <vlm.json> [--ocr <ocr.json>] [--ocr-mode rows]');
    process.exit(1);
  }

  // ── 加载 OCR（可选）──
  let ocrLinesRaw = [];
  let ocrMeta = null;
  if (ocrJsonPath) {
    const absOcr = path.resolve(ocrJsonPath);
    if (!fs.existsSync(absOcr)) {
      console.error(`OCR JSON 不存在：${absOcr}`);
      process.exit(1);
    }
    const ocrProbe = JSON.parse(fs.readFileSync(absOcr, 'utf-8'));
    ocrLinesRaw = Array.isArray(ocrProbe.lines) ? ocrProbe.lines : [];
    ocrMeta = {
      source: absOcr,
      api: ocrProbe.api || 'unknown',
      elapsedMs: ocrProbe.elapsedMs,
      lineSource: ocrProbe.lineSource || 'unknown',
      requestId: ocrProbe.requestId || null,
      imagePath: ocrProbe.imagePath || null,
    };
    console.log(`📝 OCR 执行源：${absOcr}`);
    console.log(`   原始行数：${ocrLinesRaw.length}（来源：${ocrMeta.lineSource}，耗时 ${ocrMeta.elapsedMs || 0}ms）`);
  }

  let imagePath, blocks = [], meta, rawContent;

  if (noVlm) {
    // 仅 OCR 模式：图片可从 CLI 或 OCR JSON 推出
    imagePath = inputPath ? path.resolve(inputPath) : (ocrMeta?.imagePath || null);
    if (!imagePath || !fs.existsSync(imagePath)) {
      console.error(`——no-vlm 模式需明确原图路径：${imagePath || '(未提供)'}`);
      process.exit(1);
    }
    meta = {
      imagePath,
      model: null,
      elapsedMs: 0,
      coordinateSystem: 'ocr-only',
      source: 'ocr-only',
    };
    console.log(`📷 仅 OCR 模式，原图：${imagePath}`);
  } else if (fromJsonPath) {
    // 复用已有 VLM probe 输出
    const absJson = path.resolve(fromJsonPath);
    if (!fs.existsSync(absJson)) {
      console.error(`JSON 文件不存在：${absJson}`);
      process.exit(1);
    }
    const probe = JSON.parse(fs.readFileSync(absJson, 'utf-8'));
    imagePath = probe.imagePath;
    if (!imagePath || !fs.existsSync(imagePath)) {
      console.error(`probe JSON 引用的原图不存在：${imagePath}`);
      process.exit(1);
    }
    let probeResult = probe.result;
    if (probeResult && Array.isArray(probeResult.blocks)) {
      const alreadyNormalized = probeResult.blocks.length === 0 || probeResult.blocks[0]._bboxRaw;
      if (!alreadyNormalized) {
        probeResult = normalizeVlmResult(probeResult);
      }
    } else if (probe.rawResult) {
      probeResult = normalizeVlmResult(probe.rawResult);
    } else {
      probeResult = { blocks: [] };
    }
    blocks = probeResult.blocks || [];
    meta = {
      imagePath,
      model: probe.model,
      elapsedMs: probe.elapsedMs,
      coordinateSystem: probe.coordinateSystem || 'legacy-or-renormalized',
      source: 'from-json',
      sourceFile: absJson,
      probeOk: probe.ok,
      probeError: probe.error || null,
    };
    rawContent = probe.rawContent;
    console.log(`📂 复用 VLM probe 结果：${absJson}`);
    console.log(`   原图：${imagePath}`);
    console.log(`   区块数：${blocks.length}`);
  } else {
    // 实时调用 VLM
    const absPng = path.resolve(inputPath);
    if (!fs.existsSync(absPng)) {
      console.error(`图片不存在：${absPng}`);
      process.exit(1);
    }
    const promptPath = path.join(__dirname, '..', 'config', 'prompts', 'vlmBlockDetect.txt');
    if (!fs.existsSync(promptPath)) {
      console.error(`Prompt 文件不存在：${promptPath}`);
      process.exit(1);
    }
    const blockDetectPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    const model = process.env.EMPHASIS_VLM_MODEL || 'qwen3.6-flash';
    const dataUri = imageToBase64DataUri(absPng);

    console.log(`📷 图片：${absPng}`);
    console.log(`🤖 调用 ${model}（timeout=${process.env.EMPHASIS_TASK_TIMEOUT_MS || 60000}ms）...`);
    const tStart = Date.now();
    const content = await callDashScope(model, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUri } },
        { type: 'text', text: blockDetectPrompt },
      ]},
    ], 0.2);
    const elapsedMs = Date.now() - tStart;
    rawContent = content;
    const parsed = parseJsonContent(content);
    if (!parsed) {
      console.error('❌ JSON 解析失败，原始输出片段：');
      console.error(content.slice(0, 500));
      process.exit(2);
    }
    const normalized = normalizeVlmResult(parsed);
    blocks = normalized.blocks || [];
    imagePath = absPng;
    meta = {
      imagePath: absPng,
      model,
      elapsedMs,
      coordinateSystem: `qwen-${QWEN_CANVAS}-bbox_2d`,
      source: 'live',
      promptFile: 'vlmBlockDetect.txt',
    };
    console.log(`✅ 用时 ${elapsedMs}ms，识别 ${blocks.length} 个区块`);
  }

  const imageSize = getImageSize(imagePath);
  const imageDataUri = imageToBase64DataUri(imagePath);

  // ── OCR 后处理：面积过滤 + VLM 重合过滤 + 行聚合 ──
  const ocrResult = processOcrLines(ocrLinesRaw, blocks, {
    mode: ocrMode,
    areaThreshold,
  });
  const ocrLines = ocrResult.kept;
  const ocrDropped = ocrResult.dropped;
  const ocrStats = ocrResult.stats;

  if (ocrLinesRaw.length) {
    console.log(`🧹 OCR 后处理 (mode=${ocrMode}, area≥${areaThreshold})：`);
    console.log(`   原始 ${ocrStats.inputCount} → 面积过滤后 ${ocrStats.afterArea} → VLM 过滤后 ${ocrStats.afterVlmOverlap} → 最终 ${ocrStats.finalCount}`);
  }

  const html = renderHtml({
    imageDataUri,
    imageSize,
    blocks,
    ocrLines,
    ocrDropped,
    ocrStats,
    ocrMode,
    meta: {
      ...meta,
      imageSize,
      ocr: ocrMeta,
      ocrPostProcess: { mode: ocrMode, areaThreshold, ...ocrResult.params },
      rawContentPreview: (rawContent || '').slice(0, 500),
    },
  });

  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const tag = ocrLinesRaw.length ? (noVlm ? `ocr-${ocrMode}` : `vlm+ocr-${ocrMode}`) : 'vlm-vis';
  const outPath = path.join(outDir, `${ts}-${tag}-${baseName}.html`);
  fs.writeFileSync(outPath, html, 'utf-8');

  console.log(`\n📄 可视化报告已生成：${outPath}`);
  console.log(`👉 直接用浏览器打开（macOS）： open "${outPath}"`);
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
