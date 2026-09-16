-- Who changed what, so an admin can answer "who cancelled this event?" later.
CREATE TABLE `audit_logs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `actor_id` INTEGER NULL,
  `actor_label` VARCHAR(191) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `entity_type` VARCHAR(191) NOT NULL,
  `entity_id` INTEGER NULL,
  `summary` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `audit_logs_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
  INDEX `audit_logs_created_at_idx`(`created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_id_fkey`
  FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- A venue still used by events can't be deleted without destroying their history, so it
-- gets archived instead: hidden when creating new events, kept on the old ones.
ALTER TABLE `venues` ADD COLUMN `is_archived` BOOLEAN NOT NULL DEFAULT false;
