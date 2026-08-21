CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);

CREATE VIEW approved_payments AS
SELECT * FROM payments WHERE status = 'approved';
