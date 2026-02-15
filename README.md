# ai-dev-assistant

Human-in-the-loop autonomous AI coding assistant.

## Local LLM Testing (No API Cost)

To test the full flow without paying for API calls, use a local LLM. See **[docs/LOCAL_LLM_SETUP.md](docs/LOCAL_LLM_SETUP.md)** for setup.

```bash
# Quick start with Ollama
ollama pull qwen2.5-coder
# Add LLM_PROVIDER=ollama to .env, then:
yarn dev submit -g "Add README" -r https://github.com/your/repo
```

## Docs

- **[Local LLM setup](docs/LOCAL_LLM_SETUP.md)** — Run with Ollama or mock to avoid API cost.
- **[Why "Fix it" didn't fix vitest/Yarn errors](docs/FIX_IT_AND_SANDBOX.md)** — Sandbox environment vs fix-it scope; install step and Corepack.
