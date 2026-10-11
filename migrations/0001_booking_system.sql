CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT 'Davtian Grigor LLC',
  vehicle_name TEXT NOT NULL DEFAULT '2025 BMW X5',
  tcp_number TEXT NOT NULL DEFAULT 'TCP0051387-P',
  driver_name TEXT NOT NULL DEFAULT '',
  vehicle_plate TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT 'davtya@gmail.com',
  base_fare_cents INTEGER NOT NULL DEFAULT 2500,
  per_mile_cents INTEGER NOT NULL DEFAULT 250,
  per_minute_cents INTEGER NOT NULL DEFAULT 75,
  minimum_price_cents INTEGER NOT NULL DEFAULT 7000,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  quote_nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','APPROVED','DECLINED','PAYMENT_PROCESSING','CONFIRMED','CANCELLED','REFUNDED')),
  vehicle_name TEXT NOT NULL DEFAULT '2025 BMW X5',
  pickup_address TEXT NOT NULL,
  pickup_place_id TEXT,
  destination_address TEXT NOT NULL,
  destination_place_id TEXT,
  pickup_date TEXT NOT NULL,
  pickup_time TEXT NOT NULL,
  pickup_at_iso TEXT,
  distance_miles REAL NOT NULL,
  duration_seconds INTEGER NOT NULL,
  static_duration_seconds INTEGER,
  traffic_condition TEXT,
  price_breakdown_json TEXT NOT NULL,
  estimated_price_cents INTEGER NOT NULL,
  final_price_cents INTEGER,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email','phone')),
  contact_value TEXT NOT NULL,
  request_ip_hash TEXT,
  request_user_agent TEXT,
  arrangement_method TEXT NOT NULL DEFAULT 'Electronic communication',
  approval_token_hash TEXT UNIQUE,
  approval_token_expires_at TEXT,
  allowed_payment_options_json TEXT NOT NULL DEFAULT '["10","20","full"]',
  selected_payment_option TEXT,
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('SQUARE','ZELLE')),
  payment_requested_amount_cents INTEGER,
  remaining_balance_cents INTEGER,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  customer_address TEXT,
  passenger_count INTEGER,
  driver_name TEXT,
  vehicle_plate TEXT,
  tcp_number TEXT,
  terms_version TEXT,
  terms_accepted_at TEXT,
  payment_id TEXT UNIQUE,
  payment_status TEXT,
  payment_amount_cents INTEGER,
  payment_receipt_url TEXT,
  payment_idempotency_key TEXT UNIQUE,
  payment_lock TEXT,
  payment_lock_at TEXT,
  zelle_submitted_at TEXT,
  zelle_verified_at TEXT,
  refund_id TEXT,
  refund_amount_cents INTEGER,
  refund_reason TEXT,
  owner_notes TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  declined_at TEXT,
  paid_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bookings_status_created ON bookings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup ON bookings(pickup_date, pickup_time);
CREATE INDEX IF NOT EXISTS idx_bookings_approval_token ON bookings(approval_token_hash);

CREATE TABLE IF NOT EXISTS booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id, created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT NOT NULL,
  blocked_until TEXT
);
