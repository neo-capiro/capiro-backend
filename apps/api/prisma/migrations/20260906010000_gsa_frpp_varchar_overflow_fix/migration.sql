-- GSA FRPP varchar overflow fix (Release 4 follow-up).
--
-- Production commit of FY24 FRPP failed with Prisma P2000 ("value too long for
-- column") after the first accepted rows. Live FY24 workbook scan (307,919 rows)
-- proved two overflows against the R4 column widths:
--   square_feet_uom        max 20  vs varchar(16)  e.g. 'Rentable Square Feet'
--   congressional_district max 11  vs varchar(8)   e.g. '46,47,48,49'
--
-- square_feet_uom is widened to varchar(32) so source UOMs land verbatim.
-- congressional_district is ALSO widened to varchar(32) as a defensive DB
-- ceiling; the parser still normalizes multi-district values to NULL because a
-- single asset cannot honestly claim one district key when the source lists
-- several. CD119/CD120 identity joins continue to use the (nullable) single
-- district code only.

ALTER TABLE gsa_real_property
  ALTER COLUMN square_feet_uom TYPE varchar(32);

ALTER TABLE gsa_real_property
  ALTER COLUMN congressional_district TYPE varchar(32);
