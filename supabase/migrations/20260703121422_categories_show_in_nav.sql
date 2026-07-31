ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS show_in_nav boolean NOT NULL DEFAULT true;