ALTER TABLE settlements
ADD COLUMN confirmed_amount_paise INTEGER
CHECK(confirmed_amount_paise IS NULL OR confirmed_amount_paise > 0);
