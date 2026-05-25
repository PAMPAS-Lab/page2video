# Static Page to Video

> **⚠️ 原型阶段** — 本项目目前处于早期原型阶段，API 和功能可能会变化。

将静态页面截图转换为带有 AI 智能强调动画的视频。

## 特性

- AI 驱动的 OCR + VLM 自动内容识别
- LLM 智能动画规划与时序安排
- 多种强调效果：文字高亮、发光脉冲、关键词标签
- 内置 TTS 语音合成和 ASR 语音识别
- 交互式 Web 界面，支持上传、编辑和导出
- REST API 支持程序化集成
- 可作为独立服务或 Node.js 库使用

## 技术栈

- **后端**：Node.js 20+, Express.js
- **AI**：阿里云 OCR、Qwen3.6-Flash（VLM 检测）、Qwen-Plus（聚合规划）、CosyVoice TTS、Paraformer ASR
- **渲染**：HyperFrames + Chrome Headless + FFmpeg
- **前端**：原生 JavaScript + Tailwind CSS

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- FFmpeg & FFprobe 在 PATH 中
- Chrome/Chromium（用于无头渲染）
- DashScope API Key + 阿里云 AK/SK

### 安装与运行

```bash
git clone <repository-url>
cd static-page-to-video
npm install
cp .env.example .env
# 编辑 .env，填入 API 密钥

npm start
# → http://localhost:3200
```

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `DASHSCOPE_API_KEY` | 是 | - | DashScope API 密钥 |
| `ALIYUN_ACCESS_KEY_ID` | 是 | - | 阿里云 RAM AK |
| `ALIYUN_ACCESS_KEY_SECRET` | 是 | - | 阿里云 RAM SK |
| `EMPHASIS_VLM_MODEL` | 否 | `qwen3.6-flash` | VLM 模型 |
| `EMPHASIS_AGG_MODEL` | 否 | `qwen-plus` | 聚合 LLM |
| `EMPHASIS_ASR_ENABLED` | 否 | `true` | 启用 ASR |
| `HYPERFRAMES_CHROME_PATH` | 否 | 自动 | Chrome 路径 |
| `PORT` | 否 | `3200` | 服务端口 |
| `API_KEY` | 否 | - | API 认证密钥 |

## API 接口

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/v1/generate` | 提交生成任务 |
| GET | `/api/v1/task/:taskId` | 查询任务状态 |
| POST | `/api/v1/task/:taskId/regenerate` | 重新生成 |
| GET | `/api/v1/media/:taskId/:filename` | 下载媒体 |
| POST | `/api/v1/upload/image` | 上传图片 |
| POST | `/api/v1/upload/audio` | 上传音频 |
| POST | `/api/v1/tts` | 生成 TTS |
| POST | `/api/v1/task/:taskId/detect` | 运行检测 |
| POST | `/api/v1/task/:taskId/plan` | 生成计划 |
| POST | `/api/v1/task/:taskId/render` | 渲染 MP4 |

如设置了 `API_KEY`，需在请求头中传递 `X-API-Key` 进行认证。

### 示例

```bash
# 提交任务
curl -X POST http://localhost:3200/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"imagePath":"/path/to/img.png","scriptText":"你好世界","duration":30}'

# 查询状态
curl http://localhost:3200/api/v1/task/<taskId>
```

## 作为库使用

```javascript
const { runFullPipeline } = require('static-page-to-video');

const { taskId, plan } = await runFullPipeline({
  imagePath: '/path/to/img.png',
  scriptText: '你好世界',
  duration: 30,
});
```

## 部署

### 系统依赖

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get install -y ffmpeg chromium-browser

# CentOS/RHEL
sudo yum install -y ffmpeg chromium
```

### 生产环境（PM2）

```bash
npm install -g pm2
pm2 start src/index.js --name static-page-to-video
pm2 save && pm2 startup
```

### Docker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg chromium fonts-noto-cjk --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV HYPERFRAMES_CHROME_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p media data
EXPOSE 3200
CMD ["node", "src/index.js"]
```

```bash
docker build -t static-page-to-video .
docker run -d -p 3200:3200 --env-file .env --shm-size=1gb \
  -v $(pwd)/media:/app/media -v $(pwd)/data:/app/data \
  static-page-to-video
```

### Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;
    client_max_body_size 60M;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 项目结构

```
src/
├── index.js            # 入口文件
├── pipeline.js         # 流程编排
├── config.js           # 配置管理
├── routes/             # API 路由
├── services/           # AI 服务（OCR、VLM、TTS、ASR、渲染）
├── store/              # 任务存储
└── lib/                # 工具函数
public/index.html       # Web 界面
config/                 # 提示词和模板
```

## 常见问题

- **Chrome 未找到**：设置 `HYPERFRAMES_CHROME_PATH` 指向 Chrome 可执行文件
- **FFmpeg 缺失**：通过 `brew install ffmpeg` 或 `apt-get install ffmpeg` 安装
- **OCR/VLM 失败**：检查 API 密钥和网络连接；系统会回退到基础计划

## 致谢

本项目使用 [HyperFrames](https://github.com/heygen-com/hyperframes) 进行 HTML 到 MP4 的视频渲染。

## 许可证

MIT

## 署名

由**中国科学院大学杭州高等研究院 PAMPAS 实验室**开发。

## 联系方式

如有问题，请在 GitHub 上提交 Issue。
