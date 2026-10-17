DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_price_nonnegative_check'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_price_nonnegative_check CHECK (price >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_nonnegative_check'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_stock_nonnegative_check CHECK (stock >= 0);
  END IF;
END
$$;
