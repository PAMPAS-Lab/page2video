/**
 * fileStore.js — JSON 文件存储（替代 LokiJS）
 *
 * 提供简单的键值存储，用于持久化渲染任务状态。
 * 原子写：先写 .tmp 再 rename，防止写入中断导致数据损坏。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

let cachedStore = null;

function getStorePath() {
  const dataDir = config.getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'tasks.json');
}

/**
 * 读取存储数据（带内存缓存）
 * @returns {{ tasks: Record<string, object> }}
 */
function readStore() {
  if (cachedStore) return cachedStore;

  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    cachedStore = { tasks: {} };
    return cachedStore;
  }

  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    cachedStore = JSON.parse(raw);
    if (!cachedStore.tasks) cachedStore.tasks = {};
    return cachedStore;
  } catch (_) {
    cachedStore = { tasks: {} };
    return cachedStore;
  }
}

/**
 * 写入存储数据（原子写 + 更新缓存）
 * @param {function} updater - 接收 store 对象并就地修改的函数
 */
function writeStore(updater) {
  const store = readStore();
  updater(store);

  const storePath = getStorePath();
  const tmpPath = storePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmpPath, storePath);
  cachedStore = store;
}

/**
 * 获取单个任务
 * @param {string} taskId
 * @returns {object|null}
 */
function getTask(taskId) {
  const store = readStore();
  return store.tasks[taskId] || null;
}

/**
 * 创建或更新任务
 * @param {string} taskId
 * @param {object} data - 合并到现有任务的数据
 */
function upsertTask(taskId, data) {
  writeStore((store) => {
    store.tasks[taskId] = {
      ...(store.tasks[taskId] || {}),
      ...data,
      taskId,
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * 删除任务
 * @param {string} taskId
 */
function deleteTask(taskId) {
  writeStore((store) => {
    delete store.tasks[taskId];
  });
}

/**
 * 清除内存缓存（测试用）
 */
function clearCache() {
  cachedStore = null;
}

module.exports = {
  readStore,
  writeStore,
  getTask,
  upsertTask,
  deleteTask,
  clearCache,
};
