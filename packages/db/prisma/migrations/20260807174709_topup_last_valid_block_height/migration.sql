/*
  Warnings:

  - Added the required column `last_valid_block_height` to the `wallet_topups` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "wallet_topups" ADD COLUMN     "last_valid_block_height" BIGINT NOT NULL;
