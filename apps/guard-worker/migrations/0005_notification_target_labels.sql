-- Operators may configure several targets of one kind (two Discord servers,
-- several webhooks).  A friendly label tells them apart in the dashboard.
ALTER TABLE notification_targets ADD COLUMN label TEXT;
