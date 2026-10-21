-- CreateEnum
CREATE TYPE "RefreshTokenRevokedReason" AS ENUM ('ROTATED', 'LOGOUT', 'REPLAY');

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "revokedReason" "RefreshTokenRevokedReason";
