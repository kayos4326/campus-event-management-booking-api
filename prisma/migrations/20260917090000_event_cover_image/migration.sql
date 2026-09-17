-- An event's cover image. Kept out of `events` so listing events never reads the bytes,
-- and kept in the database rather than on disk so redeploys, container rebuilds and DB
-- restores all keep the posters. `key` is random per upload: it makes the URL unguessable
-- (a draft's poster isn't public) and changes whenever the image does, so a cached copy
-- can never be stale.
CREATE TABLE `event_images` (
  `event_id` INTEGER NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `mime_type` VARCHAR(191) NOT NULL,
  `bytes` LONGBLOB NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `event_images_key_key`(`key`),
  PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4;

-- Cancelling an event keeps its row, so this only fires if an event is ever truly removed.
ALTER TABLE `event_images` ADD CONSTRAINT `event_images_event_id_fkey`
  FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
