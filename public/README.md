# Static Page to Video - Web Frontend / Web 前端

Interactive web interface for converting static page screenshots into animated videos with AI-powered emphasis overlays.

将静态页面截图转换为带有 AI 智能强调动画的交互式 Web 界面。

---

## Overview / 概述

This is a single-page application (SPA) built with vanilla JavaScript and Tailwind CSS. It provides a complete workflow for creating animated videos from static screenshots, including image/audio upload, OCR/VLM detection, animation planning, and video rendering.

这是一个使用原生 JavaScript 和 Tailwind CSS 构建的单页应用（SPA）。它提供了从静态截图创建动画视频的完整工作流程，包括图片/音频上传、OCR/VLM 检测、动画规划和视频渲染。

## Features / 功能

### Multi-Step Workflow / 多步骤工作流

1. **Upload / 上传** - Upload screenshot images and audio files, or generate TTS audio from script text
   - 上传截图图片和音频文件，或从讲稿文本生成 TTS 音频

2. **Detect / 检测** - Run AI-powered OCR and VLM detection to identify text and visual blocks
   - 运行 AI 驱动的 OCR 和 VLM 检测，识别文字和视觉区块

3. **Plan / 规划** - Generate animation plan with intelligent timing and emphasis selection
   - 生成带有智能时序和强调选择的动画计划

4. **Render / 渲染** - Preview and render the final MP4 video with emphasis overlays
   - 预览并渲染带有强调动画的最终 MP4 视频

### Key Features / 主要特性

- **Drag & Drop Upload** - Easy file upload with drag-and-drop support for images and audio
  - 拖放上传：支持图片和音频的拖放上传

- **Interactive Detection Editor** - View, edit, add, and remove OCR text lines and VLM visual blocks with bounding box overlays
  - 交互式检测编辑器：查看、编辑、添加和删除 OCR 文字行和 VLM 视觉区块，支持边界框叠加显示

- **Timeline Visualization** - Visual timeline showing emphasis timing and duration
  - 时间轴可视化：显示强调时序和持续时间的可视化时间轴

- **Plan Editor** - Fine-tune animation parameters including start/end time, animation type, and keyword
  - 计划编辑器：微调动画参数，包括开始/结束时间、动画类型和关键词

- **Real-time Preview** - Preview emphasis animations on the source image before rendering
  - 实时预览：在渲染前预览源图上的强调动画效果

- **Task Management** - Switch between multiple tasks with persistent state
  - 任务管理：在多个任务之间切换，状态持久化

- **Responsive Design** - Works on desktop and tablet screens
  - 响应式设计：适配桌面和平板屏幕

## Tech Stack / 技术栈

- **HTML5** - Semantic markup with modern HTML features
  - 语义化标记，使用现代 HTML 特性

- **Tailwind CSS** (CDN) - Utility-first CSS framework for styling
  - 实用优先的 CSS 框架

- **Vanilla JavaScript** - No framework dependencies, pure ES6+ JavaScript
  - 无框架依赖，纯 ES6+ JavaScript

- **SVG** - Bounding box overlays and timeline visualization
  - 边界框叠加和时间轴可视化

## Usage / 使用方法

### Prerequisites / 前提条件

The backend server must be running. Start it with:

后端服务必须正在运行。使用以下命令启动：

```bash
npm start
# or / 或
npm run dev
```

### Access / 访问

Open your browser and navigate to:

打开浏览器并访问：

```
http://localhost:3200/
```

### Workflow / 工作流程

#### Step 1: Upload / 步骤 1：上传

- Upload a screenshot image (PNG, JPG, WebP, etc.)
  - 上传截图图片（PNG、JPG、WebP 等）
- (Optional) Upload audio file or generate TTS from script
  - （可选）上传音频文件或从讲稿生成 TTS
- Enter your presentation script text
  - 输入你的演示讲稿文本

#### Step 2: Detect / 步骤 2：检测

- Click "Run Detection" to identify text and visual blocks
  - 点击"运行检测"识别文字和视觉区块
- Review detected OCR text lines (blue boxes) and VLM blocks (pink boxes)
  - 查看检测到的 OCR 文字行（蓝色框）和 VLM 区块（粉色框）
- Edit, add, or remove detection results as needed
  - 根据需要编辑、添加或删除检测结果

#### Step 3: Plan / 步骤 3：规划

- Click "Generate Plan" to create the animation plan
  - 点击"生成计划"创建动画计划
- Review the timeline and emphasis items
  - 查看时间轴和强调项目
- Adjust timing, animation type, and keywords if needed
  - 如需要可调整时间、动画类型和关键词

#### Step 4: Render / 步骤 4：渲染

- Click "Render Video" to generate the final MP4
  - 点击"渲染视频"生成最终 MP4
- Preview the rendered video with emphasis overlays
  - 预览带有强调动画的渲染视频
- Download the generated video
  - 下载生成的视频

## Emphasis Types / 强调类型

The frontend supports the following emphasis animation types:

前端支持以下强调动画类型：

| Type / 类型 | Description / 描述 | Badge Color / 标签颜色 |
|------|------|------|
| `text-highlight` | Yellow highlight overlay on text regions / 文字区域黄色高亮叠加 | Yellow / 黄色 |
| `glow-pulse` | Glowing pulse effect on visual blocks / 视觉区块发光脉冲效果 | Purple / 紫色 |
| `keyword-chip` | Keyword chip animation / 关键词标签动画 | Green / 绿色 |

## API Integration / API 集成

The frontend communicates with the backend via REST API endpoints:

前端通过 REST API 端点与后端通信：

| Endpoint / 端点 | Purpose / 用途 |
|----------|------|
| `POST /api/v1/upload/image` | Upload screenshot / 上传截图 |
| `POST /api/v1/upload/audio` | Upload audio / 上传音频 |
| `POST /api/v1/tts` | Generate TTS audio / 生成 TTS 音频 |
| `GET /api/v1/tasks` | List all tasks / 列出所有任务 |
| `POST /api/v1/task/:taskId/detect` | Run detection / 运行检测 |
| `GET /api/v1/task/:taskId/detection` | Get detection results / 获取检测结果 |
| `PUT /api/v1/task/:taskId/detection` | Save edited detection / 保存编辑后的检测 |
| `POST /api/v1/task/:taskId/plan` | Generate animation plan / 生成动画计划 |
| `GET /api/v1/task/:taskId/plan` | Get animation plan / 获取动画计划 |
| `PUT /api/v1/task/:taskId/plan` | Save edited plan / 保存编辑后的计划 |
| `POST /api/v1/task/:taskId/playback` | Generate playback video / 生成底片视频 |
| `POST /api/v1/task/:taskId/render` | Trigger MP4 rendering / 触发 MP4 渲染 |
| `GET /api/v1/media/:taskId/:filename` | Download media files / 下载媒体文件 |

## Customization / 自定义

### Styling / 样式

The frontend uses Tailwind CSS via CDN. To customize styles:

前端通过 CDN 使用 Tailwind CSS。自定义样式：

1. Modify the `tailwind.config` object in `index.html` to extend the theme
   - 修改 `index.html` 中的 `tailwind.config` 对象以扩展主题

2. Edit the `<style>` block for custom CSS rules
   - 编辑 `<style>` 块以自定义 CSS 规则

### Configuration / 配置

Frontend behavior can be configured via environment variables on the backend:

前端行为可以通过后端的环境变量进行配置：

- `PORT` - Server port (default: 3200) / 服务器端口（默认：3200）
- `API_KEY` - Optional API authentication / 可选 API 认证

## Browser Compatibility / 浏览器兼容性

- Chrome/Edge 90+
- Firefox 90+
- Safari 15+

Modern browsers with ES6+ support are required.

需要支持 ES6+ 的现代浏览器。

## Development / 开发

The frontend is served as a static file by the Express backend. To develop:

前端作为静态文件由 Express 后端提供服务。开发方式：

1. Edit `public/index.html` directly
   - 直接编辑 `public/index.html`

2. The backend serves it automatically at `/`
   - 后端自动在 `/` 路径提供服务

3. Refresh the browser to see changes (no build step required)
   - 刷新浏览器查看更改（无需构建步骤）

## File Structure / 文件结构

```
public/
└── index.html    # Complete SPA (HTML + CSS + JavaScript)
                  # 完整的单页应用（HTML + CSS + JavaScript）
```

## Troubleshooting / 故障排除

### Upload Fails / 上传失败

- Check file size limits (20MB for images, 50MB for audio)
  - 检查文件大小限制（图片 20MB，音频 50MB）
- Verify supported file formats
  - 验证支持的文件格式

### Detection Fails / 检测失败

- Ensure API keys are configured in `.env`
  - 确保在 `.env` 中配置了 API 密钥
- Check backend logs for error details
  - 查看后端日志获取错误详情

### Video Playback Issues / 视频播放问题

- Ensure FFmpeg is installed and in PATH
  - 确保 FFmpeg 已安装并在 PATH 中
- Check browser console for CORS or MIME type errors
  - 检查浏览器控制台的 CORS 或 MIME 类型错误

## License / 许可证

MIT License
