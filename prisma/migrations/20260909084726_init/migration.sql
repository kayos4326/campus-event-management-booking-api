-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ad_object_id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `role` ENUM('STUDENT', 'ORGANIZER', 'ADMIN') NOT NULL DEFAULT 'STUDENT',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `users_ad_object_id_key`(`ad_object_id`),
    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `venues` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `room_number` VARCHAR(191) NULL,
    `address_raw` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `static_map_url` VARCHAR(191) NULL,
    `is_verified` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `organizer_id` INTEGER NOT NULL,
    `venue_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `capacity` INTEGER NOT NULL,
    `starts_at` DATETIME(3) NOT NULL,
    `ends_at` DATETIME(3) NOT NULL,
    `is_large_conference` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('DRAFT', 'PUBLISHED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `events_venue_id_idx`(`venue_id`),
    INDEX `events_organizer_id_idx`(`organizer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_id` INTEGER NOT NULL,
    `student_id` INTEGER NOT NULL,
    `status` ENUM('CONFIRMED', 'WAITLISTED', 'CANCELLED') NOT NULL DEFAULT 'CONFIRMED',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `bookings_event_id_student_id_key`(`event_id`, `student_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merch_preorders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_id` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 50,
    `peer_order_ref` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'CONFIRMED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `merch_preorders_event_id_key`(`event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_keys` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `owner_label` VARCHAR(191) NOT NULL,
    `key_hash` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `events` ADD CONSTRAINT `events_organizer_id_fkey` FOREIGN KEY (`organizer_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `events` ADD CONSTRAINT `events_venue_id_fkey` FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_student_id_fkey` FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merch_preorders` ADD CONSTRAINT `merch_preorders_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
