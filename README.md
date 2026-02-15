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
