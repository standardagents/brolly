-- Operators may configure several targets of one kind. A friendly label
-- distinguishes each destination in the dashboard.
ALTER TABLE notification_targets ADD COLUMN label TEXT NOT NULL;
