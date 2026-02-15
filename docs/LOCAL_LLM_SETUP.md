# Testing the Full Flow with a Local LLM

This guide explains how to run the AI Dev Assistant using a **local LLM** (e.g., Ollama) instead of the Anthropic API, so you can iterate on the flow without incurring API costs.

> **Quick start:** Set `LLM_PROVIDER=ollama` in `.env`, run `ollama pull qwen2.5-coder`, then `yarn dev submit -g "Add README" -r <repo-url>`.

---

## Overview

The system supports two LLM providers:

| Provider   | Env var              | Use case                          |
|-----------|----------------------|-----------------------------------|
| `anthropic` | `ANTHROPIC_API_KEY`  | Production, best quality          |
| `ollama`    | `OLLAMA_BASE_URL`   | Local testing, zero API cost      |

---

## Option 1: Ollama (Recommended for Local Testing)

### 1. Install Ollama

**macOS (Homebrew):**
```bash
brew install ollama
```

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows:** Download from [ollama.com](https://ollama.com)

### 2. Start Ollama and Pull a Model

```bash
# Start the Ollama server (runs in background)
ollama serve   # or just: ollama run <model> which starts the server

# Pull a capable model (choose one)
ollama pull llama3.2          # Good balance of speed/quality (~2GB)
ollama pull codellama        # Code-focused (~4GB)
ollama pull deepseek-coder   # Strong at code (~3GB)
ollama pull qwen2.5-coder    # Good for code + planning (~4GB)
```

**Recommended for this use case:** `qwen2.5-coder` or `codellama` — they handle JSON planning and code generation well.

### 3. Configure the App

Create or update your `.env`:

```env
# Use local LLM
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder

# Keep these (still needed for Telegram)
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id

# Rest of config...
ANTHROPIC_API_KEY=sk-ant-xxx   # Not used when LLM_PROVIDER=ollama
```

### 4. Run the Flow

```bash
yarn build
yarn dev submit -g "Add a README with project description" -r https://github.com/your-username/your-repo
```

---

## Option 2: Mock LLM (No API, Flow-Only Testing)

For testing the **orchestration flow** (state machine, Telegram, Docker) without any real LLM:

```bash
LLM_PROVIDER=mock yarn dev submit -g "Add README" -r https://github.com/...
```

The mock returns canned plans and code. Use this to verify:

- Telegram approval flow
- Docker sandbox execution
- State transitions
- Persistence

---

## Environment Variables Reference

| Variable           | Required | Default              | Description                          |
|--------------------|----------|----------------------|--------------------------------------|
| `LLM_PROVIDER`     | No       | `anthropic`          | `anthropic` \| `ollama` \| `mock`   |
| `OLLAMA_BASE_URL`  | If ollama| `http://localhost:11434` | Ollama server URL                |
| `OLLAMA_MODEL`     | If ollama| `llama3.2`           | Model name (e.g. `qwen2.5-coder`)    |
| `ANTHROPIC_API_KEY`| If anthropic | —                | Anthropic API key                    |

---

## Model Recommendations for Ollama

| Model            | Size  | Planning | Code Gen | Speed  |
|------------------|-------|----------|----------|--------|
| `qwen2.5-coder`  | ~4GB  | ★★★★     | ★★★★★    | Medium |
| `codellama`      | ~4GB  | ★★★      | ★★★★★    | Fast   |
| `deepseek-coder` | ~3GB  | ★★★      | ★★★★     | Fast   |
| `llama3.2`       | ~2GB  | ★★★★     | ★★★      | Fast   |
| `mistral`        | ~4GB  | ★★★★     | ★★★      | Medium |

---

## Troubleshooting

### "Connection refused" when using Ollama

- Ensure Ollama is running: `ollama list` (or `ollama run <model>`)
- Check `OLLAMA_BASE_URL` — default is `http://localhost:11434`

### Plan/code output is malformed

- Try a stronger model (e.g. `qwen2.5-coder` instead of `llama3.2`)
- Local models may occasionally produce invalid JSON; the orchestrator will surface the error

### Slow responses

- Use a smaller/faster model for iteration
- Ensure enough RAM (8GB+ recommended for 4GB models)

---

## Switching Back to Anthropic

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Remove or comment out `OLLAMA_*` vars when not needed.
