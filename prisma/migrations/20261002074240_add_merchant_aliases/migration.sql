-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
