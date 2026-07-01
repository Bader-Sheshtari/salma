/** Arabic medical specialties for the doctor-transfers feature. Free-text is
 * still allowed in the admin form (datalist); this list only drives the
 * suggestions dropdown and the public filter. */
export const SPECIALTIES = [
  "طب الأطفال",
  "الجلدية",
  "الجراحة العامة",
  "جراحة العظام",
  "أمراض القلب",
  "المخ والأعصاب",
  "النساء والولادة",
  "المسالك البولية",
  "الأنف والأذن والحنجرة",
  "العيون",
  "الباطنية",
  "الغدد الصماء",
  "الجهاز الهضمي",
  "الكلى",
  "الصدرية",
  "الطب النفسي",
  "طب الأسرة",
  "طب الأسنان",
  "التجميل",
  "التغذية",
  "العلاج الطبيعي",
  "الأشعة",
  "المختبرات",
  "الأورام",
  "الروماتيزم",
  "الحساسية والمناعة",
  "الطوارئ",
  "التخدير",
  "الأطفال حديثي الولادة",
  "أمراض الدم",
  "الأمراض المعدية",
  "الطب الرياضي",
] as const;

/** Label used for the "no filter" option on the public transfers page. */
export const ALL_SPECIALTIES = "جميع التخصصات";
