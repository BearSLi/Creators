-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS', 'BD', 'CONTENT', 'FINANCE', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CreatorStatus" AS ENUM ('LEAD', 'CONTACTING', 'EVALUATING', 'SIGNED', 'ACTIVE', 'PAUSED', 'TERMINATED', 'BLACKLIST');

-- CreateEnum
CREATE TYPE "CreatorTier" AS ENUM ('S', 'A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('DOUYIN', 'XIAOHONGSHU', 'BILIBILI', 'WECHAT_CHANNEL', 'KUAISHOU', 'WEIBO', 'TIKTOK', 'YOUTUBE', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "ContentVertical" AS ENUM ('SHORT_DRAMA', 'LIFESTYLE', 'BEAUTY', 'GAMING', 'FOOD', 'TECH', 'KNOWLEDGE', 'FASHION', 'FITNESS', 'OTHER');

-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('API_OFFICIAL', 'THIRD_PARTY', 'SCREENSHOT', 'MANUAL', 'MOCK');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "SettlementMode" AS ENUM ('REVENUE_SHARE', 'FIXED_FEE', 'HYBRID', 'CPA');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'IN_PRODUCTION', 'IN_REVIEW', 'PUBLISHED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('IDEA', 'SCRIPTING', 'SHOOTING', 'EDITING', 'INTERNAL_REVIEW', 'PLATFORM_REVIEW', 'PUBLISHED', 'REJECTED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'DISPUTED', 'VOID');

-- CreateEnum
CREATE TYPE "AiTaskType" AS ENUM ('SCRIPT_GENERATE', 'TITLE_OPTIMIZE', 'CREATOR_MATCH', 'COMMENT_INSIGHT', 'COMPLIANCE_CHECK', 'SETTLEMENT_ANOMALY', 'DAILY_BRIEF');

-- CreateEnum
CREATE TYPE "AiTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'FALLBACK_USED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CONTRACT_EXPIRING', 'SETTLEMENT_DUE', 'CONTENT_REVIEW', 'ANOMALY_ALERT', 'AI_TASK_DONE', 'SYSTEM');

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "parentId" UUID,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(128) NOT NULL,
    "phone" VARCHAR(32),
    "name" VARCHAR(64) NOT NULL,
    "passwordHash" VARCHAR(128) NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "avatarUrl" VARCHAR(512),
    "teamId" UUID,
    "permissionOverrides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" VARCHAR(64),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "familyId" UUID NOT NULL,
    "userAgent" VARCHAR(256),
    "ip" VARCHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByTokenId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "color" VARCHAR(16),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "realName" VARCHAR(64),
    "idCardEncrypted" VARCHAR(512),
    "phone" VARCHAR(32),
    "wechat" VARCHAR(64),
    "email" VARCHAR(128),
    "city" VARCHAR(32),
    "status" "CreatorStatus" NOT NULL DEFAULT 'LEAD',
    "tier" "CreatorTier" NOT NULL DEFAULT 'C',
    "verticals" "ContentVertical"[] DEFAULT ARRAY[]::"ContentVertical"[],
    "styleTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "availability" JSONB,
    "agencyType" VARCHAR(32),
    "agencyName" VARCHAR(128),
    "sourceChannel" VARCHAR(64),
    "score" INTEGER NOT NULL DEFAULT 60,
    "riskLevel" VARCHAR(16) NOT NULL DEFAULT 'LOW',
    "remark" TEXT,
    "ownerId" UUID,
    "teamId" UUID,
    "createdById" UUID,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_tags" (
    "creatorId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_tags_pkey" PRIMARY KEY ("creatorId","tagId")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "nickname" VARCHAR(128) NOT NULL,
    "platformUid" VARCHAR(128) NOT NULL,
    "profileUrl" VARCHAR(512),
    "homeUrl" VARCHAR(512),
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "totalLikes" BIGINT NOT NULL DEFAULT 0,
    "totalWorks" INTEGER NOT NULL DEFAULT 0,
    "avgPlayCount" INTEGER NOT NULL DEFAULT 0,
    "engagementRateBp" INTEGER NOT NULL DEFAULT 0,
    "audienceProfile" JSONB,
    "dataSource" "DataSourceType" NOT NULL DEFAULT 'MANUAL',
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" VARCHAR(512),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_snapshots" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "statDate" DATE NOT NULL,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "followerDelta" INTEGER NOT NULL DEFAULT 0,
    "playCount" BIGINT NOT NULL DEFAULT 0,
    "likeCount" BIGINT NOT NULL DEFAULT 0,
    "commentCount" BIGINT NOT NULL DEFAULT 0,
    "shareCount" BIGINT NOT NULL DEFAULT 0,
    "collectCount" BIGINT NOT NULL DEFAULT 0,
    "engagementRateBp" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" BIGINT NOT NULL DEFAULT 0,
    "rawPayload" JSONB,
    "dataSource" "DataSourceType" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "industry" VARCHAR(64),
    "contactName" VARCHAR(64),
    "contactPhone" VARCHAR(32),
    "level" VARCHAR(8) NOT NULL DEFAULT 'B',
    "paymentTermDays" INTEGER NOT NULL DEFAULT 30,
    "invoiceTitle" VARCHAR(200),
    "taxNo" VARCHAR(64),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "creatorId" UUID NOT NULL,
    "brandId" UUID,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "settlementMode" "SettlementMode" NOT NULL DEFAULT 'REVENUE_SHARE',
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "fixedFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "platformFeeBp" INTEGER NOT NULL DEFAULT 1000,
    "agencyShareBp" INTEGER NOT NULL DEFAULT 3000,
    "talentShareBp" INTEGER NOT NULL DEFAULT 7000,
    "taxWithholdBp" INTEGER NOT NULL DEFAULT 600,
    "cpaUnitPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tieredShares" JSONB,
    "signedAt" TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3) NOT NULL,
    "exclusivity" BOOLEAN NOT NULL DEFAULT false,
    "exclusivityScope" VARCHAR(200),
    "deliverableSpec" JSONB,
    "breachClause" TEXT,
    "attachmentUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewNote" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "brandId" UUID,
    "contractId" UUID,
    "creatorId" UUID,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "vertical" "ContentVertical" NOT NULL DEFAULT 'SHORT_DRAMA',
    "budget" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "actualCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ownerId" UUID,
    "teamId" UUID,
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "brief" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contents" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32),
    "projectId" UUID,
    "creatorId" UUID NOT NULL,
    "accountId" UUID,
    "title" VARCHAR(200) NOT NULL,
    "script" TEXT,
    "aiTaskId" UUID,
    "platform" "Platform" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'IDEA',
    "platformContentId" VARCHAR(128),
    "publishedUrl" VARCHAR(512),
    "coverUrl" VARCHAR(512),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "viewCount" BIGINT NOT NULL DEFAULT 0,
    "likeCount" BIGINT NOT NULL DEFAULT 0,
    "commentCount" BIGINT NOT NULL DEFAULT 0,
    "shareCount" BIGINT NOT NULL DEFAULT 0,
    "collectCount" BIGINT NOT NULL DEFAULT 0,
    "completionRateBp" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" BIGINT NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "metricsSyncedAt" TIMESTAMP(3),
    "syncError" VARCHAR(512),
    "complianceScore" INTEGER,
    "complianceFlags" JSONB,
    "reviewerId" UUID,
    "reviewNote" TEXT,
    "rejectReason" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "creatorId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "grossAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "agencyShare" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "talentGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxWithheld" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "adjustmentReason" TEXT,
    "calculationTrace" JSONB,
    "dueDate" DATE,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentVoucherUrl" VARCHAR(512),
    "disputeReason" TEXT,
    "remark" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_items" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "contractId" UUID,
    "contentId" UUID,
    "itemType" VARCHAR(32) NOT NULL DEFAULT 'REVENUE',
    "description" VARCHAR(200) NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "platformFeeBp" INTEGER NOT NULL DEFAULT 0,
    "platformFee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "agencyShareBp" INTEGER NOT NULL DEFAULT 0,
    "agencyShare" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "talentShareBp" INTEGER NOT NULL DEFAULT 0,
    "talentGross" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxWithholdBp" INTEGER NOT NULL DEFAULT 0,
    "taxWithheld" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "userPromptTemplate" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "outputSchema" JSONB,
    "model" VARCHAR(64) NOT NULL,
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 2048,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tasks" (
    "id" UUID NOT NULL,
    "taskType" "AiTaskType" NOT NULL,
    "status" "AiTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "creatorId" UUID,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "renderedPrompt" TEXT,
    "provider" VARCHAR(32),
    "model" VARCHAR(64),
    "templateId" UUID,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "fallbackReason" VARCHAR(512),
    "errorCode" VARCHAR(64),
    "errorMessage" TEXT,
    "humanFeedback" INTEGER NOT NULL DEFAULT 0,
    "feedbackNote" TEXT,
    "requestedById" UUID,
    "idempotencyKey" VARCHAR(200),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "userName" VARCHAR(64),
    "action" VARCHAR(32) NOT NULL,
    "resource" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(64),
    "summary" VARCHAR(512) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(256),
    "requestId" VARCHAR(64),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT,
    "link" VARCHAR(512),
    "dedupeKey" VARCHAR(200),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_code_key" ON "teams"("code");

-- CreateIndex
CREATE INDEX "teams_parentId_idx" ON "teams"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "users_teamId_idx" ON "users"("teamId");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "tags_category_idx" ON "tags"("category");

-- CreateIndex
CREATE UNIQUE INDEX "creators_code_key" ON "creators"("code");

-- CreateIndex
CREATE INDEX "creators_status_tier_idx" ON "creators"("status", "tier");

-- CreateIndex
CREATE INDEX "creators_ownerId_idx" ON "creators"("ownerId");

-- CreateIndex
CREATE INDEX "creators_deletedAt_createdAt_idx" ON "creators"("deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "creators_name_idx" ON "creators"("name");

-- CreateIndex
CREATE INDEX "creator_tags_tagId_idx" ON "creator_tags"("tagId");

-- CreateIndex
CREATE INDEX "platform_accounts_creatorId_isPrimary_idx" ON "platform_accounts"("creatorId", "isPrimary");

-- CreateIndex
CREATE INDEX "platform_accounts_platform_followerCount_idx" ON "platform_accounts"("platform", "followerCount");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_platform_platformUid_key" ON "platform_accounts"("platform", "platformUid");

-- CreateIndex
CREATE INDEX "metrics_snapshots_statDate_idx" ON "metrics_snapshots"("statDate");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_snapshots_accountId_statDate_key" ON "metrics_snapshots"("accountId", "statDate");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE INDEX "brands_deletedAt_idx" ON "brands"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_code_key" ON "contracts"("code");

-- CreateIndex
CREATE INDEX "contracts_creatorId_status_idx" ON "contracts"("creatorId", "status");

-- CreateIndex
CREATE INDEX "contracts_status_effectiveTo_idx" ON "contracts"("status", "effectiveTo");

-- CreateIndex
CREATE INDEX "contracts_brandId_idx" ON "contracts"("brandId");

-- CreateIndex
CREATE INDEX "contracts_deletedAt_idx" ON "contracts"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE INDEX "projects_status_dueDate_idx" ON "projects"("status", "dueDate");

-- CreateIndex
CREATE INDEX "projects_creatorId_idx" ON "projects"("creatorId");

-- CreateIndex
CREATE INDEX "projects_brandId_idx" ON "projects"("brandId");

-- CreateIndex
CREATE INDEX "projects_ownerId_idx" ON "projects"("ownerId");

-- CreateIndex
CREATE INDEX "projects_teamId_idx" ON "projects"("teamId");

-- CreateIndex
CREATE INDEX "projects_deletedAt_idx" ON "projects"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "contents_code_key" ON "contents"("code");

-- CreateIndex
CREATE INDEX "contents_creatorId_status_idx" ON "contents"("creatorId", "status");

-- CreateIndex
CREATE INDEX "contents_projectId_idx" ON "contents"("projectId");

-- CreateIndex
CREATE INDEX "contents_platform_publishedAt_idx" ON "contents"("platform", "publishedAt");

-- CreateIndex
CREATE INDEX "contents_status_scheduledAt_idx" ON "contents"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "contents_deletedAt_idx" ON "contents"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_code_key" ON "settlements"("code");

-- CreateIndex
CREATE INDEX "settlements_status_dueDate_idx" ON "settlements"("status", "dueDate");

-- CreateIndex
CREATE INDEX "settlements_periodEnd_idx" ON "settlements"("periodEnd");

-- CreateIndex
CREATE INDEX "settlements_deletedAt_idx" ON "settlements"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_creatorId_periodStart_periodEnd_key" ON "settlements"("creatorId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_idempotencyKey_key" ON "settlement_items"("idempotencyKey");

-- CreateIndex
CREATE INDEX "settlement_items_settlementId_idx" ON "settlement_items"("settlementId");

-- CreateIndex
CREATE INDEX "settlement_items_creatorId_calculatedAt_idx" ON "settlement_items"("creatorId", "calculatedAt");

-- CreateIndex
CREATE INDEX "settlement_items_contractId_idx" ON "settlement_items"("contractId");

-- CreateIndex
CREATE INDEX "prompt_templates_key_isActive_idx" ON "prompt_templates"("key", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_version_key" ON "prompt_templates"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tasks_idempotencyKey_key" ON "ai_tasks"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_tasks_taskType_status_idx" ON "ai_tasks"("taskType", "status");

-- CreateIndex
CREATE INDEX "ai_tasks_createdAt_idx" ON "ai_tasks"("createdAt");

-- CreateIndex
CREATE INDEX "ai_tasks_creatorId_idx" ON "ai_tasks"("creatorId");

-- CreateIndex
CREATE INDEX "ai_tasks_requestedById_createdAt_idx" ON "ai_tasks"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_resource_resourceId_createdAt_idx" ON "audit_logs"("resource", "resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_tags" ADD CONSTRAINT "creator_tags_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_tags" ADD CONSTRAINT "creator_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_snapshots" ADD CONSTRAINT "metrics_snapshots_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "platform_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "prompt_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

