/**
 * hyperframes.js — AnimationPlan → HyperFrames HTML 转换 + MP4 渲染调度
 *
 * 核心模块：
 *   - planToHyperframesHtml(plan, videoSrc) → HTML 字符串
 *   - renderEmphasisMp4(taskId, plan, options) → Promise<{ mp4Path }>
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const config = require('../config');

// ── 常量 ──────────────────────────────────────────────────

const CANVAS_W = 1280;
const CANVAS_H = 720;
const FADE_DURATION = 0.8;

// ── HTML 生成 ─────────────────────────────────────────────

/**
 * 将 AnimationPlan 转换为 HyperFrames 兼容的 HTML 字符串
 */
function planToHyperframesHtml(plan, videoSrc = 'playback.mp4') {
  const duration = Number(plan.duration) || 10;
  const emphases = Array.isArray(plan.emphases) ? plan.emphases : [];

  let template;
  try {
    const templatePath = path.join(config.getTemplatesDir(), 'emphasis-hyperframes.html');
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch (_err) {
    template = getInlineTemplate();
  }

  const elements = [];
  const gsapLines = [];

  for (let i = 0; i < emphases.length; i++) {
    const emp = emphases[i];
    const id = `emp-${i + 1}`;
    const start = Number(emp.start) || 0;
    const end = Number(emp.end) || (start + 2);
    const empDuration = Math.max(0.1, end - start);
    const [nx, ny, nw, nh] = (Array.isArray(emp.bboxNorm) && emp.bboxNorm.length === 4)
      ? emp.bboxNorm.map(Number)
      : [0, 0, 1, 1];

    const left = (nx * 100).toFixed(2);
    const top = (ny * 100).toFixed(2);
    const width = (nw * 100).toFixed(2);
    const height = (nh * 100).toFixed(2);

    const type = emp.type || 'text-highlight';
    const style = `position:absolute; left:${left}%; top:${top}%; width:${width}%; height:${height}%;`;

    if (type === 'glow-pulse') {
      elements.push(
        `    <div id="${id}" class="clip emphasis-glow" data-start="${start.toFixed(1)}" data-duration="${empDuration.toFixed(1)}" data-track-index="2"`,
        `         style="${style}"></div>`
      );

      const dimId = `dim-${i + 1}`;
      elements.push(
        `    <div id="${dimId}" class="clip dim-overlay" data-start="${start.toFixed(1)}" data-duration="${empDuration.toFixed(1)}" data-track-index="1"`,
        `         style="position:absolute; top:0; left:0; width:100%; height:100%;"></div>`
      );

      const midDuration = empDuration - FADE_DURATION * 2;
      const breathCount = Math.max(1, Math.floor(midDuration / 0.8));
      gsapLines.push(`  // ${id}: glow-pulse`);
      gsapLines.push(`  tl.to("#${id}", { opacity: 1, scale: 1, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${start.toFixed(2)});`);
      if (midDuration > 0.2) {
        gsapLines.push(`  tl.to("#${id}", { scale: 1.04, duration: 0.8, yoyo: true, repeat: ${breathCount - 1}, ease: "sine.inOut" }, ${(start + FADE_DURATION).toFixed(2)});`);
      }
      gsapLines.push(`  tl.to("#${id}", { opacity: 0, scale: 1.0, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${(end - FADE_DURATION).toFixed(2)});`);
      gsapLines.push('');
      gsapLines.push(`  tl.to("#${dimId}", { opacity: 1, duration: 0.5 }, ${start.toFixed(2)});`);
      gsapLines.push(`  tl.to("#${dimId}", { opacity: 0, duration: ${FADE_DURATION} }, ${(end - FADE_DURATION).toFixed(2)});`);
      gsapLines.push('');
    } else if (type === 'text-highlight') {
      elements.push(
        `    <div id="${id}" class="clip emphasis-highlight" data-start="${start.toFixed(1)}" data-duration="${empDuration.toFixed(1)}" data-track-index="2"`,
        `         style="${style}"></div>`
      );

      gsapLines.push(`  // ${id}: text-highlight`);
      gsapLines.push(`  tl.to("#${id}", { opacity: 1, scale: 1.02, duration: ${(FADE_DURATION * 0.5).toFixed(2)}, ease: "power3.inOut" }, ${start.toFixed(2)});`);
      gsapLines.push(`  tl.to("#${id}", { scale: 1.0, duration: ${(FADE_DURATION * 0.4).toFixed(2)}, ease: "power3.inOut" }, ${(start + FADE_DURATION * 0.5).toFixed(2)});`);
      gsapLines.push(`  tl.to("#${id}", { opacity: 0, duration: ${FADE_DURATION.toFixed(2)}, ease: "power3.inOut" }, ${(end - FADE_DURATION).toFixed(2)});`);
      gsapLines.push('');
    } else if (type === 'subtitle') {
      elements.push(
        `    <div id="${id}" class="clip keyword-chip" data-start="${start.toFixed(1)}" data-duration="${empDuration.toFixed(1)}" data-track-index="3"`,
        `         style="position:absolute; left:5%; top:88%; width:90%; height:12%;">`,
        `      <span>${escapeHtml(emp.scriptSlice || emp.keyword || '')}</span>`,
        `    </div>`
      );

      gsapLines.push(`  // ${id}: subtitle`);
      gsapLines.push(`  tl.to("#${id}", { opacity: 1, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${start.toFixed(2)});`);
      gsapLines.push(`  tl.to("#${id}", { opacity: 0, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${(end - FADE_DURATION).toFixed(2)});`);
      gsapLines.push('');
    }

    if (emp.keyword && type !== 'subtitle') {
      const chipId = `chip-${i + 1}`;
      elements.push(
        `    <div id="${chipId}" class="clip keyword-chip" data-start="${start.toFixed(1)}" data-duration="${empDuration.toFixed(1)}" data-track-index="3"`,
        `         style="position:absolute; left:0; top:88%; width:100%; height:12%;">`,
        `      <span>${escapeHtml(emp.keyword)}</span>`,
        `    </div>`
      );

      gsapLines.push(`  tl.to("#${chipId}", { opacity: 1, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${start.toFixed(2)});`);
      gsapLines.push(`  tl.to("#${chipId}", { opacity: 0, duration: ${FADE_DURATION}, ease: "power3.inOut" }, ${(end - FADE_DURATION).toFixed(2)});`);
      gsapLines.push('');
    }
  }

  let html = template
    .replaceAll('{{DURATION}}', duration.toFixed(1))
    .replaceAll('playback.mp4', videoSrc)
    .replace('{{EMPHASIS_ELEMENTS}}', elements.join('\n'))
    .replace('{{GSAP_ANIMATIONS}}', gsapLines.join('\n'));

  return html;
}

function getInlineTemplate() {
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1280, height=720" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }
    .emphasis-highlight { opacity: 0; transform: scale(0.95); border: 2.5px solid rgba(255,215,0,0.85); border-radius: 8px; background: rgba(255,215,0,0.15); box-shadow: 0 0 12px 4px rgba(255,215,0,0.25), 0 0 24px 8px rgba(255,180,0,0.10); }
    .emphasis-glow { opacity: 0; transform: scale(0.95); border-radius: 14px; box-shadow: 0 0 32px 14px rgba(255,140,0,0.50), 0 0 64px 28px rgba(255,100,0,0.24), 0 0 96px 40px rgba(255,80,0,0.10), inset 0 0 18px 4px rgba(255,140,0,0.06); }
    .dim-overlay { opacity: 0; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.18); pointer-events: none; }
    .keyword-chip { opacity: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%); display: flex; align-items: flex-end; justify-content: center; padding-bottom: 12px; }
    .keyword-chip span { color: #fff; font-size: 26px; font-weight: 600; letter-spacing: 0.05em; text-shadow: 0 1px 3px rgba(0,0,0,0.8); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="emphasis" data-start="0" data-duration="{{DURATION}}" data-width="1280" data-height="720" style="position: relative; width: 1280px; height: 720px;">
    <video class="clip" data-start="0" data-duration="{{DURATION}}" data-track-index="0"
           src="playback.mp4" muted playsinline
           style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover"></video>
    <audio data-start="0" data-duration="{{DURATION}}" data-track-index="10" data-volume="1"
           src="playback.mp4"></audio>
{{EMPHASIS_ELEMENTS}}
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    var tl = gsap.timeline({ paused: true });
{{GSAP_ANIMATIONS}}
    window.__timelines["emphasis"] = tl;
  </script>
</body>
</html>`;
}

function probeVideoDuration(videoPath) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration',
       '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { timeout: 10000, encoding: 'utf8' }
    );
    const d = parseFloat(out.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch (_) {
    return 0;
  }
}

function checkSparseKeyframes(videoPath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0',
      videoPath
    ], { timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
    const keyframeTimes = out.split('\n')
      .filter(line => line.includes('K'))
      .map(line => parseFloat(line.split(',')[0]))
      .filter(t => Number.isFinite(t));
    if (keyframeTimes.length < 2) return true;
    let maxGap = 0;
    for (let i = 1; i < keyframeTimes.length; i++) {
      maxGap = Math.max(maxGap, keyframeTimes[i] - keyframeTimes[i - 1]);
    }
    return maxGap > 2.0;
  } catch (_) {
    return false;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── MP4 渲染 ─────────────────────────────────────────────

/**
 * 使用 HyperFrames 将 AnimationPlan 渲染为 MP4
 *
 * @param {string} taskId - 任务 ID
 * @param {object} plan - AnimationPlan
 * @param {object} [options]
 * @param {string} [options.videoPath] - 源视频绝对路径
 * @param {number} [options.timeoutMs] - 渲染超时（ms）
 * @param {string} [options.quality='draft'] - 渲染质量
 * @returns {Promise<{ mp4Path: string, elapsedMs: number }>}
 */
async function renderEmphasisMp4(taskId, plan, options = {}) {
  const tStart = Date.now();

  const mediaDir = config.getMediaDir();
  const taskDir = path.join(mediaDir, taskId);
  const exportDir = path.join(taskDir, 'export');
  const mp4OutputPath = path.join(exportDir, 'emphasis.mp4');

  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
  }

  const videoPath = options.videoPath || path.join(taskDir, 'playback.mp4');
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Source video not found: ${videoPath}`);
  }

  fs.mkdirSync(exportDir, { recursive: true });

  // 复制源视频到 export 目录（HyperFrames 需要相对路径访问）
  const exportVideoPath = path.join(exportDir, 'playback.mp4');
  if (!fs.existsSync(exportVideoPath)) {
    const needsReencode = checkSparseKeyframes(videoPath);
    if (needsReencode) {
      console.log(`[hyperframes] re-encoding ${taskId} with dense keyframes...`);
      try {
        execFileSync('ffmpeg', [
          '-y', '-i', videoPath,
          '-c:v', 'libx264', '-preset', 'veryfast',
          '-r', '25', '-g', '30', '-keyint_min', '30',
          '-sc_threshold', '0',
          '-movflags', '+faststart',
          '-c:a', 'copy',
          exportVideoPath
        ], { timeout: 60000, stdio: 'pipe' });
      } catch (reencErr) {
        console.warn(`[hyperframes] re-encode failed, falling back to copy:`, reencErr?.message?.slice(0, 100));
        fs.copyFileSync(videoPath, exportVideoPath);
      }
    } else {
      fs.copyFileSync(videoPath, exportVideoPath);
    }
  }

  // hyperframes.json
  const hfConfig = {
    id: `emphasis-${taskId}`,
    name: `emphasis-${taskId}`,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(exportDir, 'hyperframes.json'), JSON.stringify(hfConfig, null, 2), 'utf-8');

  // 探测视频真实时长
  const probedDuration = probeVideoDuration(exportVideoPath);
  const effectivePlan = probedDuration > 0
    ? { ...plan, duration: probedDuration }
    : plan;
  if (probedDuration > 0 && Math.abs(probedDuration - Number(plan.duration)) > 1) {
    console.log(`[hyperframes] duration override: plan=${Number(plan.duration).toFixed(1)}s → actual=${probedDuration.toFixed(1)}s`);
  }

  // index.html
  const html = planToHyperframesHtml(effectivePlan, 'playback.mp4');
  fs.writeFileSync(path.join(exportDir, 'index.html'), html, 'utf-8');

  // 渲染
  const videoDuration = Number(effectivePlan.duration) || 60;
  const dynamicTimeout = Math.max(120000, Math.ceil((60 + videoDuration * 1.5) * 1000));
  const envTimeout = config.getRenderTimeoutMs();
  const timeoutMs = options.timeoutMs || Math.max(envTimeout, dynamicTimeout);
  const quality = options.quality || 'draft';

  const chromePath = config.getChromePath();

  console.log(`[hyperframes] Rendering ${taskId} (quality=${quality}, timeout=${timeoutMs}ms)...`);

  await new Promise((resolve, reject) => {
    const child = execFile(
      'npx',
      ['hyperframes', 'render', '-o', 'emphasis.mp4', '-q', quality, '--quiet', '--workers', '1'],
      {
        cwd: exportDir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
        env: {
          ...process.env,
          ...(chromePath ? { PUPPETEER_EXECUTABLE_PATH: chromePath } : {}),
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = [
            err.message || 'HyperFrames render failed',
            stderr ? `\nstderr: ${stderr.slice(0, 500)}` : '',
            stdout ? `\nstdout: ${stdout.slice(0, 500)}` : '',
          ].join('');
          reject(new Error(msg));
          return;
        }
        resolve();
      }
    );

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`HyperFrames render timeout after ${timeoutMs}ms`));
    }, timeoutMs + 5000);

    child.on('close', () => clearTimeout(timer));
  });

  if (!fs.existsSync(mp4OutputPath)) {
    throw new Error(`HyperFrames render completed but MP4 not found: ${mp4OutputPath}`);
  }

  const elapsedMs = Date.now() - tStart;
  console.log(`[hyperframes] Render complete: ${mp4OutputPath} (${elapsedMs}ms)`);

  return { mp4Path: mp4OutputPath, elapsedMs };
}

/**
 * 解析 taskId → 路径
 */
function resolveMediaPaths(taskId) {
  const mediaDir = config.getMediaDir();
  const taskDir = path.join(mediaDir, taskId);
  const videoPath = path.join(taskDir, 'playback.mp4');
  const exportDir = path.join(taskDir, 'export');
  const mp4OutputPath = path.join(exportDir, 'emphasis.mp4');
  return { taskDir, videoPath, exportDir, mp4OutputPath };
}

module.exports = {
  planToHyperframesHtml,
  renderEmphasisMp4,
  resolveMediaPaths,
};
