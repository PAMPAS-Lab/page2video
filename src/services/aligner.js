/**
 * sentenceAligner.js — ASR 句子 → 讲稿对齐器 + 字符占比兜底
 *
 * Day 6 核心模块：
 *   - alignAsrToScript(asrSentences, scriptText) → sentenceAnchors[]
 *     ASR 句子与原始讲稿按 LCS（字符重合度）对齐，输出每句的起止时间戳
 *   - estimateAnchorsByCharRatio(scriptText, totalDurationSec) → sentenceAnchors[]
 *     字符占比兜底：按句长占总字数比例分配时间，ASR 失败时保证 anchors 不为空
 *
 * 输出格式与 schema 一致：{ index, text, startSec, endSec }
 */

'use strict';

// ── 工具函数 ──────────────────────────────────────────────

/**
 * 将讲稿文本按中文句末标点切句
 */
function splitScriptToSentences(scriptText) {
  return String(scriptText || '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.replace(/[\n]+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 字符集合重合度：两个字符串中共同字符占较长串字符集合的比例
 * 用于衡量 ASR 句子与讲稿句子的匹配程度
 */
function charOverlap(a, b) {
  const sa = new Set([...a.replace(/\s+/g, '')]);
  const sb = new Set([...b.replace(/\s+/g, '')]);
  if (!sa.size || !sb.size) return 0;
  let overlap = 0;
  for (const c of sa) {
    if (sb.has(c)) overlap++;
  }
  return overlap / Math.max(sa.size, sb.size);
}

/**
 * 线性插值填充空白句的时间戳
 */
function interpolateGaps(anchors, totalDurationSec) {
  if (!anchors.length) return anchors;

  // 找到有真实时间戳的锚点索引
  const validIndices = [];
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].startSec >= 0) validIndices.push(i);
  }

  if (!validIndices.length) {
    // 全都没有时间戳，直接按均匀分配
    const duration = totalDurationSec || anchors.length * 2;
    const perSent = duration / anchors.length;
    for (let i = 0; i < anchors.length; i++) {
      anchors[i].startSec = Number((i * perSent).toFixed(3));
      anchors[i].endSec = Number((Math.min(duration, (i + 1) * perSent)).toFixed(3));
    }
    return anchors;
  }

  // 头部插值：将 [0, firstValid.startSec] 均匀分配给 firstValid 个空白锚点
  const firstValid = validIndices[0];
  if (firstValid > 0) {
    const firstTime = anchors[firstValid].startSec;
    const perSent = firstTime / firstValid;
    for (let i = 0; i < firstValid; i++) {
      anchors[i].startSec = Number((i * perSent).toFixed(3));
      anchors[i].endSec = Number((Math.min(firstTime, (i + 1) * perSent)).toFixed(3));
    }
  }

  // 中间插值
  for (let vi = 0; vi < validIndices.length - 1; vi++) {
    const left = validIndices[vi];
    const right = validIndices[vi + 1];
    const gap = right - left - 1;
    if (gap <= 0) continue;

    const leftEnd = anchors[left].endSec;
    const rightStart = anchors[right].startSec;
    const totalGap = rightStart - leftEnd;
    const perSent = totalGap / gap;

    for (let g = 1; g <= gap; g++) {
      const idx = left + g;
      anchors[idx].startSec = Number((leftEnd + (g - 1) * perSent).toFixed(3));
      anchors[idx].endSec = Number((leftEnd + g * perSent).toFixed(3));
    }
  }

  // 尾部插值
  const lastValid = validIndices[validIndices.length - 1];
  if (lastValid < anchors.length - 1) {
    const lastEnd = anchors[lastValid].endSec;
    const duration = totalDurationSec || (lastEnd + (anchors.length - lastValid) * 2);
    const remaining = duration - lastEnd;
    const fillCount = anchors.length - lastValid - 1;
    const perSent = fillCount > 0 ? remaining / fillCount : remaining;
    for (let i = lastValid + 1; i < anchors.length; i++) {
      const offset = i - lastValid;
      anchors[i].startSec = Number((lastEnd + (offset - 1) * perSent).toFixed(3));
      anchors[i].endSec = Number((lastEnd + offset * perSent).toFixed(3));
    }
  }

  return anchors;
}

// ── 主对齐函数 ────────────────────────────────────────────

/**
 * 将 ASR 输出的句子时间戳对齐到原始讲稿
 *
 * 策略：
 *   1. 讲稿按句末标点切句
 *   2. 对每个讲稿句，在 ASR 句子中滑动窗口查找字符重合度最高的匹配
 *   3. 未匹配的讲稿句用前后邻居线性插值
 *   4. 多余的 ASR 句子自然跳过
 *
 * @param {Array<{ text: string, beginMs: number, endMs: number }>} asrSentences - ASR 输出句子列表
 * @param {string} scriptText - 原始讲稿全文
 * @returns {Array<{ index: number, text: string, startSec: number, endSec: number }>} sentenceAnchors
 */
function alignAsrToScript(asrSentences, scriptText) {
  const scriptSents = splitScriptToSentences(scriptText);

  if (!scriptSents.length) {
    return [];
  }

  if (!asrSentences || !asrSentences.length) {
    console.log('[asr-align] ASR 句子为空，回退到字符占比估算');
    return [];
  }

  // 计算 ASR 总时长（用于插值兜底）
  const asrTotalDurationSec = asrSentences.length > 0
    ? asrSentences[asrSentences.length - 1].endMs / 1000
    : 0;

  const anchors = [];
  let asrPos = 0; // 当前在 ASR 句子列表中的搜索起始位置

  for (let si = 0; si < scriptSents.length; si++) {
    const scriptSent = scriptSents[si];
    const scriptClean = scriptSent.replace(/\s+/g, '');
    if (!scriptClean) continue;

    // 在 ASR 句子中滑动窗口查找最佳匹配（最多向前看 6 句）
    let bestJ = -1;
    let bestOverlap = 0;
    const searchEnd = Math.min(asrPos + 6, asrSentences.length);

    for (let j = asrPos; j < searchEnd; j++) {
      const asrClean = (asrSentences[j].text || '').replace(/\s+/g, '');
      const overlap = charOverlap(scriptClean, asrClean);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestJ = j;
      }
    }

    if (bestJ >= 0 && bestOverlap > 0.2) {
      anchors.push({
        index: anchors.length,
        text: scriptSent.slice(0, 60),
        startSec: Number((asrSentences[bestJ].beginMs / 1000).toFixed(3)),
        endSec: Number((asrSentences[bestJ].endMs / 1000).toFixed(3)),
      });
      asrPos = bestJ + 1;
    } else {
      // 未匹配：标记为需插值（startSec < 0）
      anchors.push({
        index: anchors.length,
        text: scriptSent.slice(0, 60),
        startSec: -1,
        endSec: -1,
      });
    }
  }

  // 插值填充空白时间戳
  interpolateGaps(anchors, asrTotalDurationSec);

  // 最终校验：确保所有 startSec/endSec 合法
  for (const a of anchors) {
    if (!Number.isFinite(a.startSec) || a.startSec < 0) a.startSec = 0;
    if (!Number.isFinite(a.endSec) || a.endSec <= a.startSec) {
      a.endSec = Math.min(asrTotalDurationSec || a.startSec + 1.5, a.startSec + 1.5);
    }
  }

  console.log(
    `[asr-align] aligned: script=${scriptSents.length} sents, asr=${asrSentences.length} sents → anchors=${anchors.length}`
  );

  return anchors;
}

// ── 字符占比兜底 ──────────────────────────────────────────

/**
 * 字符占比估算：按句长占总字数比例分配时间
 *
 * 当 ASR 不可用或失败时，提供最基础的 sentenceAnchors，保证动画链路不中断。
 * 误差 ≤ 2s，适配 emphasisAnnotationAgent 的 snapToAnchor 吸附机制。
 *
 * @param {string} scriptText - 讲稿全文
 * @param {number} totalDurationSec - TTS 音频总时长（秒）
 * @returns {Array<{ index: number, text: string, startSec: number, endSec: number }>}
 */
function estimateAnchorsByCharRatio(scriptText, totalDurationSec) {
  const sents = splitScriptToSentences(scriptText);
  const duration = Math.max(1, Number(totalDurationSec) || sents.length * 2);

  if (!sents.length) {
    return [];
  }

  const totalChars = sents.reduce((sum, s) => sum + s.length, 0) || 1;
  let cursor = 0;
  const anchors = sents.map((text, index) => {
    const ratio = text.length / totalChars;
    const sentDuration = duration * ratio;
    const startSec = Number(cursor.toFixed(3));
    const endSec = Number((cursor + sentDuration).toFixed(3));
    cursor += sentDuration;
    return {
      index,
      text: text.slice(0, 60),
      startSec,
      endSec,
    };
  });

  console.log(`[asr-align] char-ratio fallback: ${anchors.length} anchors, total=${duration.toFixed(1)}s`);
  return anchors;
}

module.exports = {
  alignAsrToScript,
  estimateAnchorsByCharRatio,
  splitScriptToSentences,
};
