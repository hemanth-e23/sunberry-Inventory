-- Data backfill for Phase 3 Task 3.5 (item 2).
--
-- send_back_receipt used to write the non-enum value "sent-back" (hyphen). The
-- enum value is "sent_back" (underscore). New code writes the correct value;
-- migrate existing rows so anything filtering on the enum finds them.
--
-- Review the SELECT, then run. NOT run automatically.

-- Preview:
-- SELECT id, status FROM receipts WHERE status = 'sent-back';

UPDATE receipts SET status = 'sent_back' WHERE status = 'sent-back';
