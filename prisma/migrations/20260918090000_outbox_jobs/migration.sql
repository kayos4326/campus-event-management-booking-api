-- Durable, retryable delivery for work that follows a database change (today: posting a
-- supply order to Discord). A job is inserted in the same transaction as the change that
-- needs it; the app's worker claims due jobs with FOR UPDATE SKIP LOCKED and retries
-- failures with backoff. Replaces a fire-and-forget call that was lost on any error or
-- restart. See src/services/outbox.js.
CREATE TABLE `outbox_jobs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `type` VARCHAR(191) NOT NULL,
  `payload` JSON NOT NULL,
  `dedupe_key` VARCHAR(191) NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'DEAD') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `max_attempts` INTEGER NOT NULL DEFAULT 8,
  `run_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lock_token` VARCHAR(191) NULL,
  `locked_until` DATETIME(3) NULL,
  `last_error` TEXT NULL,
  `note` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  INDEX `outbox_jobs_status_run_at_idx`(`status`, `run_at`),
  INDEX `outbox_jobs_dedupe_key_idx`(`dedupe_key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;
