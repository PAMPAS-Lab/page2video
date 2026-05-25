# Static Page to Video

> **⚠️ Prototype** — This project is currently in early prototype stage. APIs and features may change.

Convert static page screenshots into animated videos with AI-powered emphasis overlays.

## Features

- AI-powered OCR + VLM detection for automatic content recognition
- LLM-driven animation planning with intelligent timing
- Multiple emphasis effects: text highlights, glow-pulse, keyword chips
- Built-in TTS (text-to-speech) and ASR (speech recognition)
- Interactive web interface for upload, edit, and export
- REST API for programmatic integration
- Can be used as a standalone service or as a Node.js library

## Tech Stack

- **Backend**: Node.js 20+, Express.js
- **AI**: Aliyun OCR, Qwen3.6-Flash (VLM detection), Qwen-Plus (aggregation planning), CosyVoice TTS, Paraformer ASR
- **Rendering**: HyperFrames + Chrome Headless + FFmpeg
- **Frontend**: Vanilla JS + Tailwind CSS

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- FFmpeg & FFprobe in PATH
- Chrome/Chromium (for headless rendering)
- DashScope API Key + Aliyun AK/SK

### Install & Run

```bash
git clone <repository-url>
cd static-page-to-video
npm install
cp .env.example .env
# Edit .env with your API keys

npm start
# → http://localhost:3200
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DASHSCOPE_API_KEY` | Yes | - | DashScope API key |
| `ALIYUN_ACCESS_KEY_ID` | Yes | - | Aliyun RAM AK |
| `ALIYUN_ACCESS_KEY_SECRET` | Yes | - | Aliyun RAM SK |
| `EMPHASIS_VLM_MODEL` | No | `qwen3.6-flash` | VLM model |
| `EMPHASIS_AGG_MODEL` | No | `qwen-plus` | Aggregation LLM |
| `EMPHASIS_ASR_ENABLED` | No | `true` | Enable ASR |
| `HYPERFRAMES_CHROME_PATH` | No | auto | Chrome path |
| `PORT` | No | `3200` | Server port |
| `API_KEY` | No | - | API auth key |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/generate` | Submit generation task |
| GET | `/api/v1/task/:taskId` | Query task status |
| POST | `/api/v1/task/:taskId/regenerate` | Regenerate task |
| GET | `/api/v1/media/:taskId/:filename` | Download media |
| POST | `/api/v1/upload/image` | Upload image |
| POST | `/api/v1/upload/audio` | Upload audio |
| POST | `/api/v1/tts` | Generate TTS |
| POST | `/api/v1/task/:taskId/detect` | Run detection |
| POST | `/api/v1/task/:taskId/plan` | Generate plan |
| POST | `/api/v1/task/:taskId/render` | Render MP4 |

If `API_KEY` is set, pass `X-API-Key` header for authentication.

### Example

```bash
# Submit task
curl -X POST http://localhost:3200/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"imagePath":"/path/to/img.png","scriptText":"Hello world","duration":30}'

# Check status
curl http://localhost:3200/api/v1/task/<taskId>
```

## Use as Library

```javascript
const { runFullPipeline } = require('static-page-to-video');

const { taskId, plan } = await runFullPipeline({
  imagePath: '/path/to/img.png',
  scriptText: 'Hello world',
  duration: 30,
});
```

## Deployment

### System Dependencies

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get install -y ffmpeg chromium-browser

# CentOS/RHEL
sudo yum install -y ffmpeg chromium
```

### Production (PM2)

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

### Nginx Reverse Proxy

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

## Project Structure

```
src/
├── index.js            # Entry point
├── pipeline.js         # Pipeline orchestration
├── config.js           # Configuration
├── routes/             # API routes
├── services/           # AI services (OCR, VLM, TTS, ASR, rendering)
├── store/              # Task storage
└── lib/                # Utilities
public/index.html       # Web interface
config/                 # Prompts & templates
```

## Troubleshooting

- **Chrome not found**: Set `HYPERFRAMES_CHROME_PATH` to your Chrome executable
- **FFmpeg missing**: Install via `brew install ffmpeg` or `apt-get install ffmpeg`
- **OCR/VLM fails**: Check API keys and network connectivity; system falls back to basic plan

## Acknowledgments

This project uses [HyperFrames](https://github.com/heygen-com/hyperframes) for HTML-to-MP4 video rendering.

## License

MIT

## Credits

Developed by **PAMPAS Lab**, Hangzhou Institute for Advanced Study (HIAS), University of Chinese Academy of Sciences (UCAS).

## Contact

For issues and questions, please open an issue on GitHub.
