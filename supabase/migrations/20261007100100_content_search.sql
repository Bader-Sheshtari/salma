-- CMS Phase 2 — server-side content search, tab/category counts, and
-- user-only enforcement of the content status-transition matrix.
--
-- Contents (one migration, applied as a unit):
--   1. pg_trgm extension.
--   2. public.ar_normalize(text) — IMMUTABLE SQL mirror of normalize() in
--      src/lib/search.ts, with a self-test DO block (the migration aborts if
--      any case diverges from the JS reference outputs).
--   3. Two STORED generated columns on public.content: search_norm, body_tsv.
--      Added inside a guarded DO block that asserts zero drift (see §3).
--   4. Indexes (all IF NOT EXISTS).
--   5. public.search_content(...) — admin-only keyset-paginated search/list RPC.
--   6. public.content_counts()     — admin-only tab + category-strip counts RPC.
--   7. public.content_lifecycle_before() re-created: illegal status transitions
--      by a HUMAN actor are now refused (SQLSTATE P0021); system/pipeline
--      writes stay log-only forever.
--
-- No row of public.content is modified by this migration (asserted in §3).

-- ===========================================================================
-- 1. Extension
-- ===========================================================================
create extension if not exists pg_trgm with schema extensions;

-- ===========================================================================
-- 2. ar_normalize — must stay behaviour-identical to src/lib/search.ts
-- ===========================================================================
-- JS reference (search.ts → normalize), step by step, and the SQL mirror:
--   1. .normalize("NFKC")                       → normalize(x, NFKC)
--   2. strip DIACRITICS: U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED,
--      U+0640 (tashkeel, superscript alef, Quranic marks, tatweel) → ''
--   3. أ U+0623, إ U+0625, آ U+0622, ٱ U+0671 → ا U+0627
--      ة U+0629 → ه U+0647 ;  ى U+0649 → ي U+064A
--      ؤ U+0624 → و U+0648 ;  ئ U+0626 → ي U+064A        (one translate())
--   4. /[^\p{L}\p{N}\s]/gu → ' '  (every code point that is not a Unicode
--      letter, number or JS whitespace becomes a space). Postgres regexes have
--      no \p{..} and [[:alpha:]] is locale-dependent, so the class below is the
--      EXACT complement of JS /[\p{L}\p{N}\s]/u, generated from Unicode 17
--      (Node 24 / ICU 78) as explicit code-point ranges. Regenerate with:
--        node -e 'const k=/[\p{L}\p{N}\s]/u;/* walk U+0001..U+10FFFF,
--                 emit ranges where !k.test(ch) as \\xLO-\\xHI */'
--      (surrogates D800–DFFF are folded into the surrounding range; they can
--      never occur in Postgres text).
--   5. /\s+/g → ' '  — JS \s is exactly: U+0009–000D, U+0020, U+00A0, U+1680,
--      U+2000–200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
--   6. .trim()  → btrim(x, ' ')   (after step 5 only single U+0020 can remain
--      at either end).
--   7. .toLowerCase() → lower(x)  (ASCII identical everywhere; non-ASCII case
--      folding follows the database ctype — Arabic has no case).
-- Differences by design: NULL in → NULL out (STRICT); JS returns '' for
-- null/'' and '' → '' here too.
--
-- Regex patterns are E'' strings with \\x escapes so they are independent of
-- standard_conforming_strings; the translate() maps use chr() so every code
-- point is explicit.
--
-- IMMUTABLE is required (content.search_norm / content.body_tsv are STORED
-- generated columns over it). If this function is ever changed, the stored
-- values must be regenerated (drop + re-add the two columns, or
-- ALTER TABLE ... ALTER COLUMN ... SET EXPRESSION on PG17+).
create or replace function public.ar_normalize(p_input text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $fn$
  select pg_catalog.lower(
           pg_catalog.btrim(
             pg_catalog.regexp_replace(
               pg_catalog.regexp_replace(
                 pg_catalog.translate(
                   pg_catalog.regexp_replace(
                     normalize(p_input, NFKC),
                     E'[\\x0610-\\x061A\\x064B-\\x065F\\x0670\\x06D6-\\x06ED\\x0640]',
                     '', 'g'),
                   -- from: أ إ آ ٱ ة ى ؤ ئ
                   pg_catalog.chr(1571) || pg_catalog.chr(1573) || pg_catalog.chr(1570)
                     || pg_catalog.chr(1649) || pg_catalog.chr(1577) || pg_catalog.chr(1609)
                     || pg_catalog.chr(1572) || pg_catalog.chr(1574),
                   -- to:   ا ا ا ا ه ي و ي
                   pg_catalog.chr(1575) || pg_catalog.chr(1575) || pg_catalog.chr(1575)
                     || pg_catalog.chr(1575) || pg_catalog.chr(1607) || pg_catalog.chr(1610)
                     || pg_catalog.chr(1608) || pg_catalog.chr(1610)),
                 -- not (\p{L} | \p{N} | \s) → ' '   [generated, see header]
                 E'['
                 || E'\\x0001-\\x0008\\x000E-\\x001F\\x0021-\\x002F\\x003A-\\x0040\\x005B-\\x0060\\x007B-\\x009F'
                 || E'\\x00A1-\\x00A9\\x00AB-\\x00B1\\x00B4\\x00B6-\\x00B8\\x00BB\\x00BF\\x00D7\\x00F7\\x02C2-\\x02C5'
                 || E'\\x02D2-\\x02DF\\x02E5-\\x02EB\\x02ED\\x02EF-\\x036F\\x0375\\x0378-\\x0379\\x037E\\x0380-\\x0385'
                 || E'\\x0387\\x038B\\x038D\\x03A2\\x03F6\\x0482-\\x0489\\x0530\\x0557-\\x0558\\x055A-\\x055F'
                 || E'\\x0589-\\x05CF\\x05EB-\\x05EE\\x05F3-\\x061F\\x064B-\\x065F\\x066A-\\x066D\\x0670\\x06D4'
                 || E'\\x06D6-\\x06E4\\x06E7-\\x06ED\\x06FD-\\x06FE\\x0700-\\x070F\\x0711\\x0730-\\x074C'
                 || E'\\x07A6-\\x07B0\\x07B2-\\x07BF\\x07EB-\\x07F3\\x07F6-\\x07F9\\x07FB-\\x07FF\\x0816-\\x0819'
                 || E'\\x081B-\\x0823\\x0825-\\x0827\\x0829-\\x083F\\x0859-\\x085F\\x086B-\\x086F\\x0888'
                 || E'\\x0890-\\x089F\\x08CA-\\x0903\\x093A-\\x093C\\x093E-\\x094F\\x0951-\\x0957\\x0962-\\x0965'
                 || E'\\x0970\\x0981-\\x0984\\x098D-\\x098E\\x0991-\\x0992\\x09A9\\x09B1\\x09B3-\\x09B5\\x09BA-\\x09BC'
                 || E'\\x09BE-\\x09CD\\x09CF-\\x09DB\\x09DE\\x09E2-\\x09E5\\x09F2-\\x09F3\\x09FA-\\x09FB'
                 || E'\\x09FD-\\x0A04\\x0A0B-\\x0A0E\\x0A11-\\x0A12\\x0A29\\x0A31\\x0A34\\x0A37\\x0A3A-\\x0A58\\x0A5D'
                 || E'\\x0A5F-\\x0A65\\x0A70-\\x0A71\\x0A75-\\x0A84\\x0A8E\\x0A92\\x0AA9\\x0AB1\\x0AB4\\x0ABA-\\x0ABC'
                 || E'\\x0ABE-\\x0ACF\\x0AD1-\\x0ADF\\x0AE2-\\x0AE5\\x0AF0-\\x0AF8\\x0AFA-\\x0B04\\x0B0D-\\x0B0E'
                 || E'\\x0B11-\\x0B12\\x0B29\\x0B31\\x0B34\\x0B3A-\\x0B3C\\x0B3E-\\x0B5B\\x0B5E\\x0B62-\\x0B65\\x0B70'
                 || E'\\x0B78-\\x0B82\\x0B84\\x0B8B-\\x0B8D\\x0B91\\x0B96-\\x0B98\\x0B9B\\x0B9D\\x0BA0-\\x0BA2'
                 || E'\\x0BA5-\\x0BA7\\x0BAB-\\x0BAD\\x0BBA-\\x0BCF\\x0BD1-\\x0BE5\\x0BF3-\\x0C04\\x0C0D\\x0C11\\x0C29'
                 || E'\\x0C3A-\\x0C3C\\x0C3E-\\x0C57\\x0C5B\\x0C5E-\\x0C5F\\x0C62-\\x0C65\\x0C70-\\x0C77\\x0C7F'
                 || E'\\x0C81-\\x0C84\\x0C8D\\x0C91\\x0CA9\\x0CB4\\x0CBA-\\x0CBC\\x0CBE-\\x0CDB\\x0CDF\\x0CE2-\\x0CE5'
                 || E'\\x0CF0\\x0CF3-\\x0D03\\x0D0D\\x0D11\\x0D3B-\\x0D3C\\x0D3E-\\x0D4D\\x0D4F-\\x0D53\\x0D57'
                 || E'\\x0D62-\\x0D65\\x0D79\\x0D80-\\x0D84\\x0D97-\\x0D99\\x0DB2\\x0DBC\\x0DBE-\\x0DBF\\x0DC7-\\x0DE5'
                 || E'\\x0DF0-\\x0E00\\x0E31\\x0E34-\\x0E3F\\x0E47-\\x0E4F\\x0E5A-\\x0E80\\x0E83\\x0E85\\x0E8B\\x0EA4'
                 || E'\\x0EA6\\x0EB1\\x0EB4-\\x0EBC\\x0EBE-\\x0EBF\\x0EC5\\x0EC7-\\x0ECF\\x0EDA-\\x0EDB\\x0EE0-\\x0EFF'
                 || E'\\x0F01-\\x0F1F\\x0F34-\\x0F3F\\x0F48\\x0F6D-\\x0F87\\x0F8D-\\x0FFF\\x102B-\\x103E'
                 || E'\\x104A-\\x104F\\x1056-\\x1059\\x105E-\\x1060\\x1062-\\x1064\\x1067-\\x106D\\x1071-\\x1074'
                 || E'\\x1082-\\x108D\\x108F\\x109A-\\x109F\\x10C6\\x10C8-\\x10CC\\x10CE-\\x10CF\\x10FB\\x1249'
                 || E'\\x124E-\\x124F\\x1257\\x1259\\x125E-\\x125F\\x1289\\x128E-\\x128F\\x12B1\\x12B6-\\x12B7\\x12BF'
                 || E'\\x12C1\\x12C6-\\x12C7\\x12D7\\x1311\\x1316-\\x1317\\x135B-\\x1368\\x137D-\\x137F\\x1390-\\x139F'
                 || E'\\x13F6-\\x13F7\\x13FE-\\x1400\\x166D-\\x166E\\x169B-\\x169F\\x16EB-\\x16ED\\x16F9-\\x16FF'
                 || E'\\x1712-\\x171E\\x1732-\\x173F\\x1752-\\x175F\\x176D\\x1771-\\x177F\\x17B4-\\x17D6'
                 || E'\\x17D8-\\x17DB\\x17DD-\\x17DF\\x17EA-\\x17EF\\x17FA-\\x180F\\x181A-\\x181F\\x1879-\\x187F'
                 || E'\\x1885-\\x1886\\x18A9\\x18AB-\\x18AF\\x18F6-\\x18FF\\x191F-\\x1945\\x196E-\\x196F'
                 || E'\\x1975-\\x197F\\x19AC-\\x19AF\\x19CA-\\x19CF\\x19DB-\\x19FF\\x1A17-\\x1A1F\\x1A55-\\x1A7F'
                 || E'\\x1A8A-\\x1A8F\\x1A9A-\\x1AA6\\x1AA8-\\x1B04\\x1B34-\\x1B44\\x1B4D-\\x1B4F\\x1B5A-\\x1B82'
                 || E'\\x1BA1-\\x1BAD\\x1BE6-\\x1BFF\\x1C24-\\x1C3F\\x1C4A-\\x1C4C\\x1C7E-\\x1C7F\\x1C8B-\\x1C8F'
                 || E'\\x1CBB-\\x1CBC\\x1CC0-\\x1CE8\\x1CED\\x1CF4\\x1CF7-\\x1CF9\\x1CFB-\\x1CFF\\x1DC0-\\x1DFF'
                 || E'\\x1F16-\\x1F17\\x1F1E-\\x1F1F\\x1F46-\\x1F47\\x1F4E-\\x1F4F\\x1F58\\x1F5A\\x1F5C\\x1F5E'
                 || E'\\x1F7E-\\x1F7F\\x1FB5\\x1FBD\\x1FBF-\\x1FC1\\x1FC5\\x1FCD-\\x1FCF\\x1FD4-\\x1FD5\\x1FDC-\\x1FDF'
                 || E'\\x1FED-\\x1FF1\\x1FF5\\x1FFD-\\x1FFF\\x200B-\\x2027\\x202A-\\x202E\\x2030-\\x205E'
                 || E'\\x2060-\\x206F\\x2072-\\x2073\\x207A-\\x207E\\x208A-\\x208F\\x209D-\\x2101\\x2103-\\x2106'
                 || E'\\x2108-\\x2109\\x2114\\x2116-\\x2118\\x211E-\\x2123\\x2125\\x2127\\x2129\\x212E\\x213A-\\x213B'
                 || E'\\x2140-\\x2144\\x214A-\\x214D\\x214F\\x218A-\\x245F\\x249C-\\x24E9\\x2500-\\x2775'
                 || E'\\x2794-\\x2BFF\\x2CE5-\\x2CEA\\x2CEF-\\x2CF1\\x2CF4-\\x2CFC\\x2CFE-\\x2CFF\\x2D26'
                 || E'\\x2D28-\\x2D2C\\x2D2E-\\x2D2F\\x2D68-\\x2D6E\\x2D70-\\x2D7F\\x2D97-\\x2D9F\\x2DA7\\x2DAF\\x2DB7'
                 || E'\\x2DBF\\x2DC7\\x2DCF\\x2DD7\\x2DDF-\\x2E2E\\x2E30-\\x2FFF\\x3001-\\x3004\\x3008-\\x3020'
                 || E'\\x302A-\\x3030\\x3036-\\x3037\\x303D-\\x3040\\x3097-\\x309C\\x30A0\\x30FB\\x3100-\\x3104\\x3130'
                 || E'\\x318F-\\x3191\\x3196-\\x319F\\x31C0-\\x31EF\\x3200-\\x321F\\x322A-\\x3247\\x3250'
                 || E'\\x3260-\\x327F\\x328A-\\x32B0\\x32C0-\\x33FF\\x4DC0-\\x4DFF\\xA48D-\\xA4CF\\xA4FE-\\xA4FF'
                 || E'\\xA60D-\\xA60F\\xA62C-\\xA63F\\xA66F-\\xA67E\\xA69E-\\xA69F\\xA6F0-\\xA716\\xA720-\\xA721'
                 || E'\\xA789-\\xA78A\\xA7DD-\\xA7F0\\xA802\\xA806\\xA80B\\xA823-\\xA82F\\xA836-\\xA83F\\xA874-\\xA881'
                 || E'\\xA8B4-\\xA8CF\\xA8DA-\\xA8F1\\xA8F8-\\xA8FA\\xA8FC\\xA8FF\\xA926-\\xA92F\\xA947-\\xA95F'
                 || E'\\xA97D-\\xA983\\xA9B3-\\xA9CE\\xA9DA-\\xA9DF\\xA9E5\\xA9FF\\xAA29-\\xAA3F\\xAA43\\xAA4C-\\xAA4F'
                 || E'\\xAA5A-\\xAA5F\\xAA77-\\xAA79\\xAA7B-\\xAA7D\\xAAB0\\xAAB2-\\xAAB4\\xAAB7-\\xAAB8'
                 || E'\\xAABE-\\xAABF\\xAAC1\\xAAC3-\\xAADA\\xAADE-\\xAADF\\xAAEB-\\xAAF1\\xAAF5-\\xAB00'
                 || E'\\xAB07-\\xAB08\\xAB0F-\\xAB10\\xAB17-\\xAB1F\\xAB27\\xAB2F\\xAB5B\\xAB6A-\\xAB6F\\xABE3-\\xABEF'
                 || E'\\xABFA-\\xABFF\\xD7A4-\\xD7AF\\xD7C7-\\xD7CA\\xD7FC-\\xF8FF\\xFA6E-\\xFA6F\\xFADA-\\xFAFF'
                 || E'\\xFB07-\\xFB12\\xFB18-\\xFB1C\\xFB1E\\xFB29\\xFB37\\xFB3D\\xFB3F\\xFB42\\xFB45\\xFBB2-\\xFBD2'
                 || E'\\xFD3E-\\xFD4F\\xFD90-\\xFD91\\xFDC8-\\xFDEF\\xFDFC-\\xFE6F\\xFE75\\xFEFD-\\xFEFE'
                 || E'\\xFF00-\\xFF0F\\xFF1A-\\xFF20\\xFF3B-\\xFF40\\xFF5B-\\xFF65\\xFFBF-\\xFFC1\\xFFC8-\\xFFC9'
                 || E'\\xFFD0-\\xFFD1\\xFFD8-\\xFFD9\\xFFDD-\\xFFFF\\x1000C\\x10027\\x1003B\\x1003E\\x1004E-\\x1004F'
                 || E'\\x1005E-\\x1007F\\x100FB-\\x10106\\x10134-\\x1013F\\x10179-\\x10189\\x1018C-\\x1027F'
                 || E'\\x1029D-\\x1029F\\x102D1-\\x102E0\\x102FC-\\x102FF\\x10324-\\x1032C\\x1034B-\\x1034F'
                 || E'\\x10376-\\x1037F\\x1039E-\\x1039F\\x103C4-\\x103C7\\x103D0\\x103D6-\\x103FF\\x1049E-\\x1049F'
                 || E'\\x104AA-\\x104AF\\x104D4-\\x104D7\\x104FC-\\x104FF\\x10528-\\x1052F\\x10564-\\x1056F\\x1057B'
                 || E'\\x1058B\\x10593\\x10596\\x105A2\\x105B2\\x105BA\\x105BD-\\x105BF\\x105F4-\\x105FF'
                 || E'\\x10737-\\x1073F\\x10756-\\x1075F\\x10768-\\x1077F\\x10786\\x107B1\\x107BB-\\x107FF'
                 || E'\\x10806-\\x10807\\x10809\\x10836\\x10839-\\x1083B\\x1083D-\\x1083E\\x10856-\\x10857'
                 || E'\\x10877-\\x10878\\x1089F-\\x108A6\\x108B0-\\x108DF\\x108F3\\x108F6-\\x108FA\\x1091C-\\x1091F'
                 || E'\\x1093A-\\x1093F\\x1095A-\\x1097F\\x109B8-\\x109BB\\x109D0-\\x109D1\\x10A01-\\x10A0F\\x10A14'
                 || E'\\x10A18\\x10A36-\\x10A3F\\x10A49-\\x10A5F\\x10A7F\\x10AA0-\\x10ABF\\x10AC8\\x10AE5-\\x10AEA'
                 || E'\\x10AF0-\\x10AFF\\x10B36-\\x10B3F\\x10B56-\\x10B57\\x10B73-\\x10B77\\x10B92-\\x10BA8'
                 || E'\\x10BB0-\\x10BFF\\x10C49-\\x10C7F\\x10CB3-\\x10CBF\\x10CF3-\\x10CF9\\x10D24-\\x10D2F'
                 || E'\\x10D3A-\\x10D3F\\x10D66-\\x10D6E\\x10D86-\\x10E5F\\x10E7F\\x10EAA-\\x10EAF\\x10EB2-\\x10EC1'
                 || E'\\x10EC8-\\x10EFF\\x10F28-\\x10F2F\\x10F46-\\x10F50\\x10F55-\\x10F6F\\x10F82-\\x10FAF'
                 || E'\\x10FCC-\\x10FDF\\x10FF7-\\x11002\\x11038-\\x11051\\x11070\\x11073-\\x11074\\x11076-\\x11082'
                 || E'\\x110B0-\\x110CF\\x110E9-\\x110EF\\x110FA-\\x11102\\x11127-\\x11135\\x11140-\\x11143'
                 || E'\\x11145-\\x11146\\x11148-\\x1114F\\x11173-\\x11175\\x11177-\\x11182\\x111B3-\\x111C0'
                 || E'\\x111C5-\\x111CF\\x111DB\\x111DD-\\x111E0\\x111F5-\\x111FF\\x11212\\x1122C-\\x1123E'
                 || E'\\x11241-\\x1127F\\x11287\\x11289\\x1128E\\x1129E\\x112A9-\\x112AF\\x112DF-\\x112EF'
                 || E'\\x112FA-\\x11304\\x1130D-\\x1130E\\x11311-\\x11312\\x11329\\x11331\\x11334\\x1133A-\\x1133C'
                 || E'\\x1133E-\\x1134F\\x11351-\\x1135C\\x11362-\\x1137F\\x1138A\\x1138C-\\x1138D\\x1138F\\x113B6'
                 || E'\\x113B8-\\x113D0\\x113D2\\x113D4-\\x113FF\\x11435-\\x11446\\x1144B-\\x1144F\\x1145A-\\x1145E'
                 || E'\\x11462-\\x1147F\\x114B0-\\x114C3\\x114C6\\x114C8-\\x114CF\\x114DA-\\x1157F\\x115AF-\\x115D7'
                 || E'\\x115DC-\\x115FF\\x11630-\\x11643\\x11645-\\x1164F\\x1165A-\\x1167F\\x116AB-\\x116B7'
                 || E'\\x116B9-\\x116BF\\x116CA-\\x116CF\\x116E4-\\x116FF\\x1171B-\\x1172F\\x1173C-\\x1173F'
                 || E'\\x11747-\\x117FF\\x1182C-\\x1189F\\x118F3-\\x118FE\\x11907-\\x11908\\x1190A-\\x1190B\\x11914'
                 || E'\\x11917\\x11930-\\x1193E\\x11940\\x11942-\\x1194F\\x1195A-\\x1199F\\x119A8-\\x119A9'
                 || E'\\x119D1-\\x119E0\\x119E2\\x119E4-\\x119FF\\x11A01-\\x11A0A\\x11A33-\\x11A39\\x11A3B-\\x11A4F'
                 || E'\\x11A51-\\x11A5B\\x11A8A-\\x11A9C\\x11A9E-\\x11AAF\\x11AF9-\\x11BBF\\x11BE1-\\x11BEF'
                 || E'\\x11BFA-\\x11BFF\\x11C09\\x11C2F-\\x11C3F\\x11C41-\\x11C4F\\x11C6D-\\x11C71\\x11C90-\\x11CFF'
                 || E'\\x11D07\\x11D0A\\x11D31-\\x11D45\\x11D47-\\x11D4F\\x11D5A-\\x11D5F\\x11D66\\x11D69'
                 || E'\\x11D8A-\\x11D97\\x11D99-\\x11D9F\\x11DAA-\\x11DAF\\x11DDC-\\x11DDF\\x11DEA-\\x11EDF'
                 || E'\\x11EF3-\\x11F01\\x11F03\\x11F11\\x11F34-\\x11F4F\\x11F5A-\\x11FAF\\x11FB1-\\x11FBF'
                 || E'\\x11FD5-\\x11FFF\\x1239A-\\x123FF\\x1246F-\\x1247F\\x12544-\\x12F8F\\x12FF1-\\x12FFF'
                 || E'\\x13430-\\x13440\\x13447-\\x1345F\\x143FB-\\x143FF\\x14647-\\x160FF\\x1611E-\\x1612F'
                 || E'\\x1613A-\\x167FF\\x16A39-\\x16A3F\\x16A5F\\x16A6A-\\x16A6F\\x16ABF\\x16ACA-\\x16ACF'
                 || E'\\x16AEE-\\x16AFF\\x16B30-\\x16B3F\\x16B44-\\x16B4F\\x16B5A\\x16B62\\x16B78-\\x16B7C'
                 || E'\\x16B90-\\x16D3F\\x16D6D-\\x16D6F\\x16D7A-\\x16E3F\\x16E97-\\x16E9F\\x16EB9-\\x16EBA'
                 || E'\\x16ED4-\\x16EFF\\x16F4B-\\x16F4F\\x16F51-\\x16F92\\x16FA0-\\x16FDF\\x16FE2\\x16FE4-\\x16FF1'
                 || E'\\x16FF7-\\x16FFF\\x18CD6-\\x18CFE\\x18D1F-\\x18D7F\\x18DF3-\\x1AFEF\\x1AFF4\\x1AFFC\\x1AFFF'
                 || E'\\x1B123-\\x1B131\\x1B133-\\x1B14F\\x1B153-\\x1B154\\x1B156-\\x1B163\\x1B168-\\x1B16F'
                 || E'\\x1B2FC-\\x1BBFF\\x1BC6B-\\x1BC6F\\x1BC7D-\\x1BC7F\\x1BC89-\\x1BC8F\\x1BC9A-\\x1CCEF'
                 || E'\\x1CCFA-\\x1D2BF\\x1D2D4-\\x1D2DF\\x1D2F4-\\x1D35F\\x1D379-\\x1D3FF\\x1D455\\x1D49D'
                 || E'\\x1D4A0-\\x1D4A1\\x1D4A3-\\x1D4A4\\x1D4A7-\\x1D4A8\\x1D4AD\\x1D4BA\\x1D4BC\\x1D4C4\\x1D506'
                 || E'\\x1D50B-\\x1D50C\\x1D515\\x1D51D\\x1D53A\\x1D53F\\x1D545\\x1D547-\\x1D549\\x1D551'
                 || E'\\x1D6A6-\\x1D6A7\\x1D6C1\\x1D6DB\\x1D6FB\\x1D715\\x1D735\\x1D74F\\x1D76F\\x1D789\\x1D7A9'
                 || E'\\x1D7C3\\x1D7CC-\\x1D7CD\\x1D800-\\x1DEFF\\x1DF1F-\\x1DF24\\x1DF2B-\\x1E02F\\x1E06E-\\x1E0FF'
                 || E'\\x1E12D-\\x1E136\\x1E13E-\\x1E13F\\x1E14A-\\x1E14D\\x1E14F-\\x1E28F\\x1E2AE-\\x1E2BF'
                 || E'\\x1E2EC-\\x1E2EF\\x1E2FA-\\x1E4CF\\x1E4EC-\\x1E4EF\\x1E4FA-\\x1E5CF\\x1E5EE-\\x1E5EF'
                 || E'\\x1E5FB-\\x1E6BF\\x1E6DF\\x1E6E3\\x1E6E6\\x1E6EE-\\x1E6EF\\x1E6F5-\\x1E6FD\\x1E700-\\x1E7DF'
                 || E'\\x1E7E7\\x1E7EC\\x1E7EF\\x1E7FF\\x1E8C5-\\x1E8C6\\x1E8D0-\\x1E8FF\\x1E944-\\x1E94A'
                 || E'\\x1E94C-\\x1E94F\\x1E95A-\\x1EC70\\x1ECAC\\x1ECB0\\x1ECB5-\\x1ED00\\x1ED2E\\x1ED3E-\\x1EDFF'
                 || E'\\x1EE04\\x1EE20\\x1EE23\\x1EE25-\\x1EE26\\x1EE28\\x1EE33\\x1EE38\\x1EE3A\\x1EE3C-\\x1EE41'
                 || E'\\x1EE43-\\x1EE46\\x1EE48\\x1EE4A\\x1EE4C\\x1EE50\\x1EE53\\x1EE55-\\x1EE56\\x1EE58\\x1EE5A'
                 || E'\\x1EE5C\\x1EE5E\\x1EE60\\x1EE63\\x1EE65-\\x1EE66\\x1EE6B\\x1EE73\\x1EE78\\x1EE7D\\x1EE7F'
                 || E'\\x1EE8A\\x1EE9C-\\x1EEA0\\x1EEA4\\x1EEAA\\x1EEBC-\\x1F0FF\\x1F10D-\\x1FBEF\\x1FBFA-\\x1FFFF'
                 || E'\\x2A6E0-\\x2A6FF\\x2B81E-\\x2B81F\\x2CEAE-\\x2CEAF\\x2EBE1-\\x2EBEF\\x2EE5E-\\x2F7FF'
                 || E'\\x2FA1E-\\x2FFFF\\x3134B-\\x3134F\\x3347A-\\x10FFFF'
                 || E']',
                 ' ', 'g'),
               E'[\\x0009-\\x000D\\x0020\\x00A0\\x1680\\x2000-\\x200A\\x2028\\x2029\\x202F\\x205F\\x3000\\xFEFF]+',
               ' ', 'g'),
             ' '))
$fn$;

comment on function public.ar_normalize(text) is
  'Arabic/Latin search normalization. IMMUTABLE mirror of normalize() in src/lib/search.ts — keep both in sync; stored generated columns content.search_norm/body_tsv depend on it.';

grant execute on function public.ar_normalize(text) to anon, authenticated, service_role;

-- Self-test: expected values are the outputs of search.ts normalize() for the
-- same inputs (computed with Node 24). Any divergence aborts the migration
-- before the table is touched.
do $$
declare
  r     record;
  v_got text;
begin
  for r in
    select * from (values
      -- diacritics + hamza-on-alef (typed and code-point-built forms)
      ('أَصْحَاء', 'اصحاء'),
      (chr(1571) || chr(1614) || 'ص' || chr(1618) || 'ح' || chr(1614) || 'ا' || 'ء', 'اصحاء'),
      ('اصحاء', 'اصحاء'),
      ('أحمد', 'احمد'),
      ('إسلام', 'اسلام'),
      ('آمنة', 'امنه'),
      (chr(1649) || 'لله', 'الله'),                        -- ٱ wasla
      ('مستشفى', 'مستشفي'),                                -- ى → ي
      ('مسؤول', 'مسوول'),                                   -- ؤ → و
      ('رئيس', 'رييس'),                                     -- ئ → ي
      ('كـــورونا', 'كورونا'),                              -- tatweel
      ('ه' || chr(1648) || 'ذا', 'هذا'),                   -- superscript alef
      ('ا' || chr(1619), 'ا'),                             -- alef+maddah → NFKC آ → ا
      ('مُسْتَشْفَى الأَمِيرِيّ', 'مستشفي الاميري'),
      ('وزارة الصحة: ١٠ إصابات جديدة بـ«كوفيد-١٩»',
       'وزاره الصحه ١٠ اصابات جديده ب كوفيد ١٩'),
      ('«الصحة»: تقرير؟', 'الصحه تقرير'),                  -- Arabic punctuation
      ('٢٠٢٤', '٢٠٢٤'),                                    -- Arabic-Indic digits kept
      (chr(1642) || '50', '50'),                           -- ٪ U+066A
      (chr(65275), 'لا'),                                  -- ﻻ presentation form (NFKC)
      (chr(65010), 'الله'),                                -- ﷲ ligature (NFKC)
      -- Latin / whitespace / symbols
      ('  Hello,   WORLD!  ', 'hello world'),
      ('كوفيد-19', 'كوفيد 19'),
      ('C++ & Python_3', 'c python 3'),
      (chr(65313) || chr(65314) || chr(65315), 'abc'),     -- full-width ＡＢＣ
      ('a' || chr(160) || 'b', 'a b'),                     -- NBSP
      ('a' || chr(8204) || 'b', 'a b'),                    -- ZWNJ (Cf) → space
      ('a' || chr(10) || chr(9) || 'b', 'a b'),            -- newline + tab
      ('صحة ' || chr(128138), 'صحه'),                       -- emoji 💊
      ('', '')
    ) as t(input, expected)
  loop
    v_got := public.ar_normalize(r.input);
    if v_got is distinct from r.expected then
      raise exception 'ar_normalize self-test failed: input=% expected=% got=%',
        quote_literal(r.input), quote_literal(r.expected), quote_literal(v_got);
    end if;
  end loop;

  if public.ar_normalize(null) is not null then
    raise exception 'ar_normalize self-test failed: NULL input must return NULL';
  end if;
  if public.ar_normalize('أَصْحَاء') is distinct from public.ar_normalize('اصحاء') then
    raise exception 'ar_normalize self-test failed: diacritic/hamza folding';
  end if;
  if (select provolatile from pg_proc
       where oid = 'public.ar_normalize(text)'::regprocedure) <> 'i' then
    raise exception 'ar_normalize must be IMMUTABLE';
  end if;
end $$;

-- ===========================================================================
-- 3. Stored generated search columns
-- ===========================================================================
-- ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED rewrites the
-- table (≈1k rows, brief ACCESS EXCLUSIVE lock). A table rewrite is not DML:
-- NO row-level trigger fires — content_set_updated_at, content_lifecycle_before
-- and content_lifecycle_after do not run — so updated_at / last_edited_at /
-- version are untouched and no audit event or version snapshot is written.
-- The DO block below proves it (snapshot → alter → assert zero drift) and is a
-- single atomic statement regardless of how the runner wraps transactions.
--
-- Generation expressions call only IMMUTABLE functions: public.ar_normalize,
-- text concatenation, coalesce, and the 2-arg to_tsvector(regconfig, text).
do $$
declare
  v_rows_before  bigint;
  v_rows_after   bigint;
  v_audit_before bigint;
  v_audit_after  bigint;
  v_vers_before  bigint;
  v_vers_after   bigint;
  v_drift        bigint;
  v_unfilled     bigint;
begin
  drop table if exists pg_temp._content_search_snapshot;
  create temp table _content_search_snapshot on commit drop as
    select id, updated_at, last_edited_at, version, status, published_at
      from public.content;
  select count(*) into v_rows_before  from _content_search_snapshot;
  select count(*) into v_audit_before from public.content_audit_log;
  select count(*) into v_vers_before  from public.content_versions;

  alter table public.content
    add column if not exists search_norm text
      generated always as (
        public.ar_normalize(
          coalesce(title, '') || ' ' || coalesce(original_title, '') || ' ' || coalesce(excerpt, ''))
      ) stored,
    add column if not exists body_tsv tsvector
      generated always as (
        to_tsvector('simple'::regconfig, public.ar_normalize(coalesce(body, '')))
      ) stored;

  select count(*) into v_rows_after  from public.content;
  select count(*) into v_audit_after from public.content_audit_log;
  select count(*) into v_vers_after  from public.content_versions;
  select count(*) into v_drift
    from public.content c
    join _content_search_snapshot s on s.id = c.id
   where c.updated_at     is distinct from s.updated_at
      or c.last_edited_at is distinct from s.last_edited_at
      or c.version        is distinct from s.version
      or c.status         is distinct from s.status
      or c.published_at   is distinct from s.published_at;
  select count(*) into v_unfilled
    from public.content c
   where c.search_norm is null or c.body_tsv is null;

  if v_rows_after <> v_rows_before or v_drift <> 0 or v_unfilled <> 0
     or v_audit_after <> v_audit_before or v_vers_after <> v_vers_before then
    raise exception
      'content search columns aborted: rows %→%, drift=%, unfilled=%, audit %→%, versions %→%',
      v_rows_before, v_rows_after, v_drift, v_unfilled,
      v_audit_before, v_audit_after, v_vers_before, v_vers_after;
  end if;

  raise notice 'content search columns OK: % rows, 0 drift, no triggers fired', v_rows_after;
end $$;

-- ===========================================================================
-- 4. Indexes
-- ===========================================================================
-- Trigram index for substring search on search_norm. The operator class is
-- resolved in whatever schema pg_trgm lives in (extensions on Supabase).
do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';
  execute format(
    'create index if not exists content_search_norm_trgm_idx on public.content using gin (search_norm %I.gin_trgm_ops)',
    v_schema);
end $$;

create index if not exists content_body_tsv_idx
  on public.content using gin (body_tsv);

-- Tab lists sorted by last edit (draft / pending / unpublished / rejected / all).
create index if not exists content_status_edited_idx
  on public.content (status, last_edited_at desc nulls last, id desc)
  where deleted_at is null;

-- Published tab (no category) sorted by publication date — the default landing
-- view. (Addition to the spec list: the category-led index below cannot serve
-- an ORDER BY published_at without a category filter.)
create index if not exists content_status_published_idx
  on public.content (status, published_at desc nulls last, id desc)
  where deleted_at is null;

-- Category views sorted by publication date.
create index if not exists content_cat_status_published_idx
  on public.content (category_slug, status, published_at desc nulls last, id desc)
  where deleted_at is null;

-- Trash sorted by deletion time.
create index if not exists content_trash_idx
  on public.content (deleted_at desc nulls last, id desc)
  where deleted_at is not null;

-- People filters.
create index if not exists content_created_by_idx
  on public.content (created_by) where created_by is not null;
create index if not exists content_reviewed_by_idx
  on public.content (reviewed_by) where reviewed_by is not null;
create index if not exists content_published_by_idx
  on public.content (published_by) where published_by is not null;

-- ===========================================================================
-- 5. search_content — admin list/search RPC (keyset pagination)
-- ===========================================================================
-- SECURITY INVOKER (RLS applies) + explicit is_admin() guard. Never returns body.
--
-- p_status : 'published' (default) | 'draft' | 'pending' | 'unpublished' |
--            'rejected' | 'all' (every non-deleted row) | 'trash'
--            (deleted_at IS NOT NULL, any status). All non-trash values
--            exclude soft-deleted rows.
-- p_sort   : 'published_desc' | 'published_asc' | 'edited_desc' | 'deleted_desc'.
--            NULL → per-tab default: trash → deleted_desc; published →
--            published_desc; everything else (incl. 'all' / global search) →
--            edited_desc. 'deleted_desc' outside trash falls back to the default.
-- p_q      : normalized with ar_normalize; matches
--            search_norm LIKE '%q%' (trigram index; q can never contain
--            % _ or \ because ar_normalize turns them into spaces)
--            OR body_tsv @@ plainto_tsquery('simple', q). Blank → no filter.
-- p_from / p_to : inclusive calendar days in Asia/Kuwait, applied to the
--            active sort column (published_at / last_edited_at / deleted_at).
--            Rows whose sort column is NULL are excluded by a date filter.
-- p_author : created_by = p_author; p_author_system = true → created_by IS NULL
--            (takes precedence). p_reviewer → reviewed_by; p_publisher →
--            published_by.
-- Keyset   : ORDER BY <sort col> <dir> NULLS LAST, id <dir>. Next page: pass the
--            LAST row's sort-column value as p_cursor_ts (exactly as returned —
--            do not round-trip through a JS Date, which drops microseconds) and
--            its id as p_cursor_id. A NULL p_cursor_ts with a non-NULL
--            p_cursor_id means "the last row was in the NULLs-last tail" — this
--            keeps published_* sorts correct in tabs where published_at can be
--            NULL ('all', drafts, ...), so no row is ever skipped or repeated.
-- p_limit  : clamped to 1..101 (default 50); the app asks for page size + 1 (max 100 + 1)
--            to detect a next page.
-- author_name / deleted_by_name: profiles.full_name (email if the name is
--            blank); NULL when created_by / deleted_by is NULL (UI renders
--            «سلمى (آلي)» for a NULL author).
create or replace function public.search_content(
  p_q             text        default null,
  p_status        text        default 'published',
  p_category      text        default null,
  p_from          date        default null,
  p_to            date        default null,
  p_author        uuid        default null,
  p_author_system boolean     default false,
  p_reviewer      uuid        default null,
  p_publisher     uuid        default null,
  p_sort          text        default null,
  p_cursor_ts     timestamptz default null,
  p_cursor_id     uuid        default null,
  p_limit         integer     default 50
)
returns table (
  id               uuid,
  title            text,
  slug             text,
  type             text,
  status           text,
  category_slug    text,
  category_name_ar text,
  published_at     timestamptz,
  last_edited_at   timestamptz,
  deleted_at       timestamptz,
  author_name      text,
  deleted_by_name  text,
  version          integer
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_status text    := pg_catalog.lower(coalesce(nullif(btrim(p_status), ''), 'published'));
  v_sort   text    := pg_catalog.lower(nullif(btrim(p_sort), ''));
  v_q      text    := nullif(public.ar_normalize(p_q), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 101);
  v_col    text;
  v_dir    text;
  v_cmp    text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_where  text[]  := array[]::text[];
  v_sql    text;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_status not in ('all','draft','pending','published','rejected','unpublished','trash') then
    raise exception 'search_content: invalid p_status %', quote_literal(p_status)
      using errcode = '22023';
  end if;
  if v_sort is not null
     and v_sort not in ('published_desc','published_asc','edited_desc','deleted_desc') then
    raise exception 'search_content: invalid p_sort %', quote_literal(p_sort)
      using errcode = '22023';
  end if;

  -- Sort resolution (whitelist only — v_col/v_dir are the only identifiers
  -- interpolated into the dynamic SQL; every value goes through USING).
  if v_sort = 'deleted_desc' and v_status <> 'trash' then
    v_sort := null;
  end if;
  if v_sort is null then
    v_sort := case v_status
                when 'trash'     then 'deleted_desc'
                when 'published' then 'published_desc'
                else 'edited_desc'
              end;
  end if;
  v_col := case v_sort
             when 'edited_desc'  then 'c.last_edited_at'
             when 'deleted_desc' then 'c.deleted_at'
             else 'c.published_at'
           end;
  v_dir := case when v_sort = 'published_asc' then 'asc'  else 'desc' end;
  v_cmp := case when v_sort = 'published_asc' then '>'    else '<'    end;

  -- Status / trash scope.
  if v_status = 'trash' then
    v_where := array_append(v_where, 'c.deleted_at is not null');
  else
    v_where := array_append(v_where, 'c.deleted_at is null');
    if v_status <> 'all' then
      v_where := array_append(v_where, 'c.status = $2');
    end if;
  end if;

  if p_category is not null then
    v_where := array_append(v_where, 'c.category_slug = $3');
  end if;

  -- Date range on the active sort column, Kuwait calendar days, inclusive.
  if p_from is not null then
    v_from  := p_from::timestamp at time zone 'Asia/Kuwait';
    v_where := array_append(v_where, format('%s >= $4', v_col));
  end if;
  if p_to is not null then
    v_to    := (p_to + 1)::timestamp at time zone 'Asia/Kuwait';
    v_where := array_append(v_where, format('%s < $5', v_col));
  end if;

  if coalesce(p_author_system, false) then
    v_where := array_append(v_where, 'c.created_by is null');
  elsif p_author is not null then
    v_where := array_append(v_where, 'c.created_by = $6');
  end if;
  if p_reviewer is not null then
    v_where := array_append(v_where, 'c.reviewed_by = $7');
  end if;
  if p_publisher is not null then
    v_where := array_append(v_where, 'c.published_by = $8');
  end if;

  if v_q is not null then
    v_where := array_append(v_where,
      '(c.search_norm like (''%'' || $1 || ''%'')'
      || ' or c.body_tsv @@ plainto_tsquery(''simple''::regconfig, $1))');
  end if;

  -- Keyset cursor (NULLS LAST aware).
  if p_cursor_id is not null then
    if p_cursor_ts is not null then
      v_where := array_append(v_where,
        format('((%1$s, c.id) %2$s ($9, $10) or %1$s is null)', v_col, v_cmp));
    else
      v_where := array_append(v_where,
        format('(%1$s is null and c.id %2$s $10)', v_col, v_cmp));
    end if;
  end if;

  v_sql := format($q$
    select c.id, c.title, c.slug, c.type, c.status, c.category_slug, cat.name_ar,
           c.published_at, c.last_edited_at, c.deleted_at,
           case when c.created_by is null then null
                else coalesce(nullif(btrim(pa.full_name), ''), pa.email) end,
           case when c.deleted_by is null then null
                else coalesce(nullif(btrim(pd.full_name), ''), pd.email) end,
           c.version
      from public.content c
      left join public.categories cat on cat.slug = c.category_slug
      left join public.profiles   pa  on pa.id    = c.created_by
      left join public.profiles   pd  on pd.id    = c.deleted_by
     where %1$s
     order by %2$s %3$s nulls last, c.id %3$s
     limit $11
  $q$, array_to_string(v_where, ' and '), v_col, v_dir);

  return query execute v_sql
    using v_q, v_status, p_category, v_from, v_to,
          p_author, p_reviewer, p_publisher,
          p_cursor_ts, p_cursor_id, v_limit;
end;
$$;

comment on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer) is
  'CMS Phase 2: admin content list/search with keyset pagination. Admin-only; never returns body.';

revoke all on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer)
  from public, anon;
grant execute on function public.search_content(text, text, text, date, date, uuid, boolean, uuid, uuid, text, timestamptz, uuid, integer)
  to authenticated, service_role;

-- ===========================================================================
-- 6. content_counts — tab badges + category-strip counts (one pass)
-- ===========================================================================
-- Rows (scope, status, category_slug, n):
--   scope 'status'   : one row per status of NON-deleted rows
--                      ('draft','pending','published','rejected','unpublished'),
--                      plus status 'all' (all non-deleted) and status 'trash'
--                      (deleted_at IS NOT NULL, any status). category_slug NULL.
--   scope 'category' : per (status, category_slug) for non-deleted rows, plus
--                      status 'all' per category. category_slug NULL here means
--                      "uncategorised". No per-category rows for trash.
-- Statuses/categories with zero rows are absent (treat missing as 0).
create or replace function public.content_counts()
returns table (scope text, status text, category_slug text, n bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select (case when grouping(g.cat) = 1 then 'status' else 'category' end)::text,
         (case when grouping(g.st)  = 1 then 'all'    else g.st       end)::text,
         (case when grouping(g.cat) = 1 then null     else g.cat      end)::text,
         case when grouping(g.st) = 1
              then count(*) filter (where g.st <> 'trash')
              else count(*)
         end
    from (select case when c.deleted_at is not null then 'trash' else c.status end as st,
                 c.category_slug as cat
            from public.content c) g
   group by grouping sets ((g.st), (g.st, g.cat), (), (g.cat))
  having not (grouping(g.st) = 0 and grouping(g.cat) = 0 and g.st = 'trash')
     and (grouping(g.st) = 0 or count(*) filter (where g.st <> 'trash') > 0)
   order by 1, 2, 3;
end;
$$;

comment on function public.content_counts() is
  'CMS Phase 2: admin tab counts (scope=status, incl. all/trash) and category-strip counts (scope=category). Admin-only.';

revoke all on function public.content_counts() from public, anon;
grant execute on function public.content_counts() to authenticated, service_role;

-- ===========================================================================
-- 7. content_lifecycle_before — re-created with USER-ONLY transition enforcement
-- ===========================================================================
-- SAFETY CONTRACT (Phase 1, amended in Phase 2):
--   * Exactly ONE intentional RAISE: an illegal status transition on UPDATE by
--     a HUMAN actor (auth.uid() resolving to a profiles row) is refused with
--     SQLSTATE P0021, message 'SALMA_ILLEGAL_TRANSITION: <from> -> <to>'.
--     The exception handler re-raises P0021 explicitly, so the generic
--     WHEN OTHERS fallback can never swallow it.
--   * Everything else still NEVER blocks a content write: on any unexpected
--     error the handler emits a WARNING and returns the unmodified row.
--   * System/pipeline writes (ingest-news / ESL / radar via service role — no
--     auth.uid(), or an auth.uid() without a profiles row) are NEVER refused:
--     illegal transitions stay LOG-ONLY for them (recorded by
--     content_lifecycle_after as details.illegal_transition), forever.
--   * INSERTs are never checked (new manual articles are created as 'draft'
--     app-side; pipeline inserts 'pending').
--   * The check runs on the FINAL status, after the trigger's own adjustments:
--     the restore flip (deleted published row restored → 'unpublished') is a
--     published → unpublished transition, which is legal.
--   * The publish rule (publish only from 'pending' or 'unpublished') is still
--     also enforced app-side (resolveStatusTransition in actions.ts).
--
-- Transition matrix (anything → same status is always allowed):
--   draft       → pending
--   pending     → published | draft | rejected
--   published   → unpublished
--   unpublished → published | draft
--   rejected    → draft
--
-- Publication dates (authoritative here; the app does not stamp them):
--   * first_published_at is write-once.
--   * Editing an already-published article never changes published_at.
--   * Publish / republish sets published_at = the ORIGINAL first publication
--     date (now() only for a first-ever publish); last_published_at = now().
--
-- content_lifecycle_after is unchanged (migration 20261007000106).
create or replace function public.content_lifecycle_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid;
  v_orig    public.content;
  v_allowed boolean;
begin
  v_orig := new;

  -- Acting human (NULL = system / pipeline / unknown user).
  v_uid := auth.uid();
  if v_uid is not null
     and not exists (select 1 from public.profiles p where p.id = v_uid) then
    v_uid := null;
  end if;

  begin
    -- ---------------------------------------------------------------- INSERT
    if tg_op = 'INSERT' then
      new.created_by     := coalesce(new.created_by, v_uid);
      new.version        := 1;
      new.last_edited_at := coalesce(new.last_edited_at, now());
      if new.status = 'published' then
        new.published_at       := coalesce(new.published_at, now());
        new.first_published_at := coalesce(new.first_published_at, new.published_at);
        new.last_published_at  := coalesce(new.last_published_at, new.published_at);
        new.published_by       := coalesce(new.published_by, v_uid);
      end if;
      return new;
    end if;

    -- ---------------------------------------------------------------- UPDATE
    -- (c) Soft delete / restore. A restored article never goes live by itself.
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := coalesce(v_uid, new.deleted_by);
    elsif new.deleted_at is null and old.deleted_at is not null then
      if new.status = 'published' then
        new.status := 'unpublished';
      end if;
    end if;

    -- (f) Transition guard — ENFORCED for human actors only (Phase 2).
    -- Evaluated on the final status (after the restore flip above).
    if v_uid is not null and new.status is distinct from old.status then
      v_allowed := case old.status
        when 'draft'       then new.status = 'pending'
        when 'pending'     then new.status in ('published','draft','rejected')
        when 'published'   then new.status = 'unpublished'
        when 'unpublished' then new.status in ('published','draft')
        when 'rejected'    then new.status = 'draft'
        else false
      end;
      if not coalesce(v_allowed, false) then
        raise exception 'SALMA_ILLEGAL_TRANSITION: % -> %', old.status, new.status
          using errcode = 'P0021',
                detail  = 'انتقال غير مسموح بين حالات المحتوى.',
                hint    = 'Allowed: draft->pending; pending->published|draft|rejected; '
                          || 'published->unpublished; unpublished->published|draft; rejected->draft.';
      end if;
    end if;

    -- (a) The original publication date is write-once.
    -- Publication metadata can only be set by a transition INTO 'published':
    -- outside one, the original values are kept (no backdating via plain edits).
    if old.first_published_at is not null then
      new.first_published_at := old.first_published_at;
    elsif not (new.status = 'published' and old.status is distinct from 'published') then
      new.first_published_at := null;
    end if;
    if not (new.status = 'published' and old.status is distinct from 'published') then
      new.published_by      := old.published_by;
      new.last_published_at := old.last_published_at;
    end if;

    if old.status = 'published' and new.status = 'published' then
      -- (a) Editing a live article never moves its publication date.
      new.published_at := coalesce(old.published_at, new.published_at);
    elsif new.status = 'published' then
      -- (b) Publish / republish: restore the original date.
      new.first_published_at := coalesce(old.first_published_at, old.published_at, now());
      new.published_at       := new.first_published_at;
      new.last_published_at  := now();
      new.published_by       := coalesce(v_uid, new.published_by);
    elsif old.status = 'published' then
      -- (b) Taken off the public site (→ unpublished, or any other status).
      new.unpublished_by := v_uid;
      new.unpublished_at := now();
    end if;

    -- The homepage hero must be a live article.
    if new.is_featured and (
         (old.status = 'published' and new.status <> 'published')
      or (new.deleted_at is not null and old.deleted_at is null)) then
      new.is_featured := false;
    end if;

    -- (e) Content edit → new version. Status/flag/date changes are not edits.
    if (new.title, new.slug, new.excerpt, new.body, new.ai_summary, new.category_slug,
        new.type, new.cover_image_url, new.cover_credit_name, new.cover_credit_url,
        new.source_name, new.source_url, new.video_url)
       is distinct from
       (old.title, old.slug, old.excerpt, old.body, old.ai_summary, old.category_slug,
        old.type, old.cover_image_url, old.cover_credit_name, old.cover_credit_url,
        old.source_name, old.source_url, old.video_url) then
      new.last_edited_at := now();
      new.last_edited_by := coalesce(v_uid, new.last_edited_by);
      new.version        := old.version + 1;
    else
      new.version := old.version;   -- version only moves with a real edit
    end if;

    -- (d) slug change after first publication, and illegal transitions by
    -- system actors, are LOG-ONLY: recorded by content_lifecycle_after.
    return new;
  exception
    when sqlstate 'P0021' then
      -- Intentional refusal (human actor, illegal transition): propagate.
      raise;
    when others then
      raise warning 'content_lifecycle_before skipped (content %): %', v_orig.id, sqlerrm;
      return v_orig;
  end;
end;
$$;

-- Trigger-only function: no direct RPC execution (see 20260731113326).
-- (create or replace keeps the trigger binding and existing privileges; the
-- revoke is repeated for clarity.)
revoke execute on function public.content_lifecycle_before() from public, anon, authenticated;

-- ROLLBACK:
-- 1. Re-run 20261007000106_content_lifecycle_triggers.sql (restores the
--    log-only content_lifecycle_before).
-- 2. drop function if exists public.content_counts();
--    drop function if exists public.search_content(text, text, text, date, date, uuid,
--      boolean, uuid, uuid, text, timestamptz, uuid, integer);
-- 3. drop index if exists public.content_published_by_idx, public.content_reviewed_by_idx,
--      public.content_created_by_idx, public.content_trash_idx,
--      public.content_cat_status_published_idx, public.content_status_published_idx,
--      public.content_status_edited_idx, public.content_body_tsv_idx,
--      public.content_search_norm_trgm_idx;
-- 4. alter table public.content drop column if exists body_tsv,
--      drop column if exists search_norm;   -- (rewrite; fires no row triggers)
-- 5. drop function if exists public.ar_normalize(text);
--    (pg_trgm may stay installed.)
