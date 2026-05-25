/**
 * envLoader.js — 工具脚本公共 .env / .alikey 加载器
 *
 * 所有 tools/*.js 脚本统一 require 此模块加载环境变量。
 * 不覆盖已存在的环境变量（process.env 优先）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function loadEnv() {
  // 1. 加载 .env
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

  // 2. 加载 .alikey（AK/SK 兜底）
  const aliKeyPath = path.join(PROJECT_ROOT, '.alikey');
  if (fs.existsSync(aliKeyPath)) {
    const lines = fs.readFileSync(aliKeyPath, 'utf-8').split('\n').map(s => s.trim());
    if (lines[0] && !process.env.ALIYUN_ACCESS_KEY_ID) {
      process.env.ALIYUN_ACCESS_KEY_ID = lines[0];
    }
    if (lines[1] && !process.env.ALIYUN_ACCESS_KEY_SECRET) {
      process.env.ALIYUN_ACCESS_KEY_SECRET = lines[1];
    }
  }
}

// 加载时立即执行
loadEnv();

module.exports = { loadEnv, PROJECT_ROOT };
