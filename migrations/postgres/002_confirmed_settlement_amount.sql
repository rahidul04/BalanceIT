ALTER TABLE settlements
ADD COLUMN confirmed_amount_paise BIGINT
CHECK(confirmed_amount_paise IS NULL OR confirmed_amount_paise > 0);
