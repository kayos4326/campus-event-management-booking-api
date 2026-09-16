-- Supply requests used to be a fixed "50 blank lanyards" triggered by a boolean flag.
-- Organizers now say what they need and how many, so the item is stored per request.
ALTER TABLE `merch_preorders` ADD COLUMN `item` VARCHAR(191) NOT NULL DEFAULT 'Blank lanyards';
ALTER TABLE `merch_preorders` ALTER COLUMN `quantity` DROP DEFAULT;
