
-- Rename category slug شصاير-في-داوي -> dawi-news via insert-new/re-point/delete-old
-- (FKs are ON UPDATE NO ACTION, so an in-place PK rename is not possible).

-- 1. Create the new category as a copy, updating name_en to "Dawi News"
INSERT INTO categories (slug, name_ar, name_en, accent, sort_order, show_in_nav)
SELECT 'dawi-news', name_ar, 'Dawi News', accent, sort_order, show_in_nav
FROM categories WHERE slug = 'شصاير-في-داوي';

-- 2. Re-point the article
UPDATE content SET category_slug = 'dawi-news'
WHERE category_slug = 'شصاير-في-داوي';

-- 3. Re-point the homepage section (FK column + key)
UPDATE homepage_sections
SET category_slug = 'dawi-news', key = 'category:dawi-news'
WHERE category_slug = 'شصاير-في-داوي';

-- 4. Remove the old category (no children reference it anymore)
DELETE FROM categories WHERE slug = 'شصاير-في-داوي';
