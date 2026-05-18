# Quick Start — HealthAgent CLI (`ha`)

## Prerequisites

- Node.js >= 18
- npm >= 9

```bash
node --version   # >= 18
npm --version    # >= 9
```

## 1. Install Dependencies

```bash
cd /path/to/incubation-healthcare-agent
npm install
```

## 2. Build

```bash
npm run build
```

This compiles the TypeScript source under `src/` into `dist/cli.cjs`.

## 3. Register the `ha` Command Globally

```bash
npm link
```

After this, `ha` is available in any terminal session. Verify:

```bash
ha --version
```

## 4. Configure API Keys

Copy the example env file and edit it:

```bash
cp .env.example .env
```

### Example: MLX (Apple Silicon local inference)

MLX exposes an OpenAI-compatible API. If your MLX server is running on port 8000:

```bash
HEALTHAGENT_API_BASE_URL=http://localhost:8000/v1
HEALTHAGENT_API_KEY=local
HEALTHAGENT_MODEL=your-mlx-model-name
```

To find your model name:

```bash
curl http://localhost:8000/v1/models
```

Use the `id` field from the response as `HEALTHAGENT_MODEL`.

### Other Supported Backends

| Backend | `HEALTHAGENT_API_BASE_URL` | `HEALTHAGENT_API_KEY` |
|---------|---------------------------|----------------------|
| Azure OpenAI | `https://YOUR-RESOURCE.openai.azure.com` | your Azure key |
| Anthropic API | *(omit — set `ANTHROPIC_API_KEY` instead)* | — |
| Ollama | `http://localhost:11434/v1` | `local` |

### Optional: PubMed / NCBI

If you want the PubMed research tool, also add:

```bash
NCBI_API_KEY=your-ncbi-key-here
```

## 5. Run

```bash
ha
```

`.env` is gitignored — never commit real credentials.
