# KYC Module

**Status:** ✅ Implemented

Enterprise-grade Identity Verification module for Pine. Handles document upload,
image enhancement, OCR extraction, face detection/matching, fraud detection,
confidence scoring, and automated/manual decision workflows.

## Architecture

```
Upload → Validate → Enhance(Sharp) → OCR(Tesseract) → Face(ONNX/InsightFace) →
Match → Fraud Rules → Confidence Score → Decision Engine → Approve/Review/Reject
```

## Provider Abstraction

All CV components use a strategy pattern — swap by changing one DI binding:

| Token | Current Provider | Future Options |
|---|---|---|
| `IMAGE_PROCESSING_PROVIDER` | SharpProvider | Cloud-based, OpenCV |
| `OCR_PROVIDER` | TesseractProvider | PaddleOCR, Google Vision |
| `FACE_RECOGNITION_PROVIDER` | InsightFaceProvider | AWS Rekognition, Azure Face |
| `KYC_REPOSITORY` | KycRepository (Prisma) | HTTP client for microservice |

## API Endpoints

### Customer
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/kyc/start` | Start new KYC application |
| `POST` | `/v1/kyc/upload-id` | Upload national ID (multipart) |
| `POST` | `/v1/kyc/upload-selfie` | Upload selfie (multipart) |
| `POST` | `/v1/kyc/process` | Trigger verification pipeline |
| `GET`  | `/v1/kyc/status/:userId` | Get KYC status |
| `GET`  | `/v1/kyc/result/:appId` | Get verification result |
| `POST` | `/v1/kyc/retry` | Retry failed verification |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/admin/kyc/pending` | List applications for review |
| `GET`  | `/v1/admin/kyc/review` | Get full review data |
| `POST` | `/v1/admin/kyc/approve` | Approve application |
| `POST` | `/v1/admin/kyc/reject` | Reject application |

## Confidence Engine

| Component | Weight | Source |
|---|---|---|
| OCR Accuracy | 30% | Tesseract field confidence |
| Face Match | 40% | Cosine similarity |
| Image Quality | 15% | Sharpness + brightness + resolution |
| Document Quality | 10% | Field completeness |
| Fraud Risk | 5% | Inverse risk score |

## Model Management (Option C)

InsightFace ONNX models are stored in a Docker volume at `/app/models/insightface`:
- **Development**: Set `KYC_MODEL_DIR=./models/insightface`, models auto-skipped if absent
- **Production**: Mount volume with models, fails fast if missing

Required models: `det_10g.onnx`, `w600k_r50.onnx` (buffalo_l pack)

## Dependencies

```bash
npm install sharp tesseract.js onnxruntime-node
```
