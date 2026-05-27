-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- Seed defaults
INSERT INTO "platform_settings" ("key", "value", "updated_at") VALUES
  ('invite_expiry_days', '7', NOW()),
  ('max_file_size_mb', '50', NOW()),
  ('maintenance_mode', 'false', NOW()),
  ('registration_enabled', 'true', NOW())
ON CONFLICT ("key") DO NOTHING;
