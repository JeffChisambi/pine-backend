-- CreateTable
-- Stores per-image ArcFace embeddings (selfie + national_id) so the KYC
-- pipeline can compute and persist a facial match. The FaceEmbedding model
-- existed in schema.prisma but no migration ever created this table, so
-- prisma.faceEmbedding.deleteMany()/create() failed with P2021 on every run
-- and the whole verification pipeline aborted (no face score recorded).
CREATE TABLE "kyc_face_embeddings" (
    "id" UUID NOT NULL,
    "kycApplicationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceType" TEXT NOT NULL,
    "embeddingData" BYTEA NOT NULL,
    "detectionConfidence" DOUBLE PRECISION NOT NULL,
    "qualityScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_face_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kyc_face_embeddings_userId_idx" ON "kyc_face_embeddings"("userId");

-- CreateIndex
CREATE INDEX "kyc_face_embeddings_kycApplicationId_idx" ON "kyc_face_embeddings"("kycApplicationId");

-- CreateIndex
CREATE INDEX "kyc_face_embeddings_sourceType_idx" ON "kyc_face_embeddings"("sourceType");

-- AddForeignKey
ALTER TABLE "kyc_face_embeddings" ADD CONSTRAINT "kyc_face_embeddings_kycApplicationId_fkey" FOREIGN KEY ("kycApplicationId") REFERENCES "kyc_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_face_embeddings" ADD CONSTRAINT "kyc_face_embeddings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
