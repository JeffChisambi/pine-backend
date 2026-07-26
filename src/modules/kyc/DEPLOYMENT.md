# KYC Module — VPS Deployment Instructions

## Prerequisites on the VPS

```bash
# Ensure Docker Compose ≥ 2.x is installed
docker compose version

# Confirm the model volume mount path exists (create once)
mkdir -p ~/pine-stack/models/insightface
```

## First-time: place InsightFace models

The face-recognition pipeline requires two ONNX models from the InsightFace
**buffalo_l** model pack. Download them once and place them on the VPS:

```bash
# On your local machine (or directly on VPS if outbound internet is allowed):
pip install -U insightface
python - <<'EOF'
import insightface, os
app = insightface.app.FaceAnalysis(name='buffalo_l')
app.prepare(ctx_id=-1)
# Models land in ~/.insightface/models/buffalo_l/
EOF

# Copy to the server location the compose file mounts:
scp ~/.insightface/models/buffalo_l/det_10g.onnx   user@vps:~/pine-stack/models/insightface/
scp ~/.insightface/models/buffalo_l/w600k_r50.onnx  user@vps:~/pine-stack/models/insightface/
```

Confirm the correct env var is set in your `.env` (or Docker Compose override):

```
KYC_MODEL_DIR=/app/models/insightface
```

And mount it in `docker-compose.yml`:

```yaml
services:
  backend:
    volumes:
      - ~/pine-stack/models/insightface:/app/models/insightface:ro
```

## Confirm `eng.traineddata` is present

The English Tesseract language data is committed to the repository root.
It is baked into the Docker image automatically — no extra step needed.

```bash
# Verify it exists after build:
docker compose exec backend ls /app/eng.traineddata
```

## Deploy a new build

```bash
# ── On your development machine ───────────────────────────────────────
git add .
git commit -m "feat: fix KYC pipeline bugs + add Mastercard Gateway module"
git push origin main

# ── On the VPS ───────────────────────────────────────────────────────
cd ~/pine-stack/pine-backend

git pull

docker compose build backend --no-cache

docker compose up -d
```

## Roll back to the previous image (if needed)

```bash
cd ~/pine-stack/pine-backend
docker compose down
git checkout HEAD~1
docker compose build backend --no-cache
docker compose up -d
```

## Smoke-test after deployment

```bash
# Health check
curl -s http://localhost:3000/health | jq .

# KYC endpoint (requires auth token)
curl -s -H "Authorization: Bearer <token>" http://localhost:3000/v1/kyc/status | jq .
```

## Environment variables added by these changes

| Variable | Required | Description |
|---|---|---|
| `KYC_MODEL_DIR` | Optional (default `./models/insightface`) | Path to ONNX model directory inside the container |
| `MCGS_BASE_URL` | Optional | NBM Mastercard Gateway base URL |
| `MCGS_MERCHANT_ID` | Optional | Gateway merchant ID |
| `MCGS_API_PASSWORD` | Optional | Gateway API password |
| `MCGS_API_VERSION` | Optional (default `100`) | Gateway API version |
| `MCGS_ENVIRONMENT` | Optional (default `TEST`) | `TEST` or `PRODUCTION` |

All `MCGS_*` vars are optional — the app boots without them; the Mastercard
endpoints simply return a 503 until credentials are configured.
