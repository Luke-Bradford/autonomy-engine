-- #1600 OR41 C11c — `external_waits.early_callback`: a Web *Wait for callback*
-- whose callback arrived BEFORE the node parked (the endpoint called back
-- before it answered the request). The completer settles the row `completed`
-- and keeps `{"callback": <its JSON>, "reportedError"?: <text>}` here; the
-- driver's arm reads it and settles the node instead of parking it. NULL means
-- none arrived early. Nullable, so every existing row is already correct.

ALTER TABLE external_waits ADD COLUMN early_callback TEXT;
