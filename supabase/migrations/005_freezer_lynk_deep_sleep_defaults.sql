-- Update Freezer Lynk settings for deep-sleep device handling
-- Sets expected reporting intervals and offline thresholds for healthy device detection
-- without flapping between ONLINE/OFFLINE on normal sleep cycles

UPDATE freezer_lynk_settings
SET 
  logging_interval_minutes = 8,
  heartbeat_minutes = 8,
  offline_after_minutes = 30,
  updated_at = now()
WHERE 
  enabled = true
  AND (
    logging_interval_minutes IS NULL 
    OR logging_interval_minutes < 8
    OR offline_after_minutes IS NULL 
    OR offline_after_minutes < 30
  );

-- Verify the updates
SELECT 
  device_id,
  logging_interval_minutes,
  heartbeat_minutes,
  offline_after_minutes
FROM freezer_lynk_settings
WHERE enabled = true
ORDER BY created_at DESC;
