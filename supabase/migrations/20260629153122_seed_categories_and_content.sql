-- Categories
insert into public.categories (slug, name_ar, name_en, accent, sort_order) values
  ('kuwait','الكويت','Kuwait','#449785',1),
  ('gulf','الخليج','Gulf','#449785',2),
  ('world','العالم','World','#449785',3),
  ('health-economy','اقتصاد الصحة','Health Economy','#5496CF',4),
  ('lifestyle','صحة وحياة','Health & Life','#68BBCA',5),
  ('investigations','تحقيقات','Investigations','#2E2E2D',6)
on conflict (slug) do nothing;

-- Content
insert into public.content
  (type, title, slug, excerpt, body, ai_summary, category_slug, status, origin, video_duration, read_minutes, is_breaking, is_featured, published_at)
values
  ('news','وزارة الصحة تعتمد توسعة مركز جابر الأحمد لجراحة القلب بطاقة 200 سرير','jaber-heart-expansion',
   'خطوة نوعية لتعزيز قدرات جراحة القلب في الكويت ضمن خطة تطوير القطاع الصحي.',
   'اعتمدت وزارة الصحة مشروع توسعة مركز جابر الأحمد لجراحة القلب ليصل إلى طاقة استيعابية تبلغ 200 سرير، في إطار خطة شاملة لتطوير الخدمات الصحية التخصصية.

تشمل التوسعة أجنحة عناية مركزة جديدة وغرف عمليات مجهزة بأحدث التقنيات، إضافة إلى توسيع برامج التدريب للكوادر الطبية الوطنية.',
   'وزارة الصحة تعتمد توسعة مركز جابر الأحمد لجراحة القلب إلى 200 سرير، مع أجنحة عناية مركزة وغرف عمليات حديثة وبرامج تدريب موسّعة.',
   'kuwait','published','manual',null,3,false,true, now()),

  ('news','افتتاح وحدة الأورام الجديدة في مستشفى العدان الأسبوع المقبل','adan-oncology-unit',
   'الوحدة الجديدة تضم أحدث أجهزة العلاج الإشعاعي وتخدم محافظات الجنوب.','تستعد وزارة الصحة لافتتاح وحدة الأورام الجديدة في مستشفى العدان الأسبوع المقبل، والمزوّدة بأحدث أجهزة العلاج الإشعاعي والكيماوي.','','kuwait','published','manual',null,2,false,false, now() - interval '1 hour'),

  ('news','حملة وطنية للكشف المبكر عن السكري في المراكز الصحية','diabetes-screening-campaign',
   'الحملة تستهدف فحص آلاف المراجعين مجاناً خلال الشهرين المقبلين.','أطلقت وزارة الصحة حملة وطنية للكشف المبكر عن السكري في المراكز الصحية، تتضمن فحوصات مجانية وبرامج توعية.','','kuwait','published','manual',null,2,false,false, now() - interval '2 hours'),

  ('news','المراكز الصحية تبدأ تطبيق نظام المواعيد الإلكتروني الموحّد','unified-appointments-system',
   'النظام الجديد يتيح حجز المواعيد عبر تطبيق موحّد لجميع المراكز.','بدأت المراكز الصحية تطبيق نظام المواعيد الإلكتروني الموحّد لتقليل أوقات الانتظار وتحسين تجربة المراجعين.','','kuwait','published','manual',null,2,false,false, now() - interval '3 hours'),

  ('news','مستشفى الصباح يدشّن جهاز رنين مغناطيسي بتقنية حديثة','sabah-mri',
   'الجهاز الجديد يرفع دقة التشخيص ويقلّل مدة الفحص.','دشّن مستشفى الصباح جهاز رنين مغناطيسي بتقنية حديثة يسهم في رفع دقة التشخيص وتقليل مدة الفحص للمرضى.','','kuwait','published','manual',null,2,false,false, now() - interval '5 hours'),

  ('news','الصحة: نقص بعض الأدوية المزمنة يُحَل خلال أسبوعين','chronic-meds-shortage',
   'الوزارة تؤكد توفّر بدائل وتسريع التوريد.','أكدت وزارة الصحة أن نقص بعض الأدوية المزمنة سيُحَل خلال أسبوعين عبر تسريع عمليات التوريد وتوفير بدائل.','','kuwait','published','manual',null,2,true,false, now() - interval '6 hours'),

  ('news','الصحة تعلن خطة لتوظيف 300 طبيب خلال 2026','hiring-300-doctors',
   'الخطة تستهدف سدّ النقص في التخصصات الدقيقة.','أعلنت وزارة الصحة خطة لتوظيف 300 طبيب خلال عام 2026 لسدّ النقص في عدد من التخصصات الدقيقة.','','kuwait','published','manual',null,2,true,false, now() - interval '8 hours'),

  ('news','شراكة بين دار الشفاء ومجموعة طبية إماراتية','darshifa-uae-partnership',
   'الشراكة تشمل نقل الخبرات وبرامج التدريب المشترك.','أعلنت مستشفى دار الشفاء عن شراكة مع مجموعة طبية إماراتية تشمل نقل الخبرات وبرامج التدريب المشترك.','','gulf','published','manual',null,2,true,false, now() - interval '10 hours'),

  ('video','ما الفرق بين النوبة القلبية والسكتة الدماغية؟','heart-attack-vs-stroke',
   'تبسيط طبي يوضح الفروقات والأعراض وكيفية التصرف.','حلقة تبسيط طبي توضح الفرق بين النوبة القلبية والسكتة الدماغية، وأبرز الأعراض وكيفية التصرف في كل حالة.','','lifestyle','published','manual','3:12',null,false,false, now() - interval '1 day'),

  ('video','مقابلة: مستقبل زراعة الأعضاء في الكويت','organ-transplant-future',
   'حوار حول التطورات والتحديات في زراعة الأعضاء.','مقابلة موسّعة حول مستقبل زراعة الأعضاء في الكويت، والتطورات والتحديات التي تواجه هذا المجال.','','kuwait','published','manual','8:45',null,false,false, now() - interval '2 days'),

  ('video','كيف تقرأ نتائج تحليل الدم؟ — حلقة جديدة','read-blood-test',
   'دليل مبسّط لفهم أهم مؤشرات تحاليل الدم.','حلقة جديدة تشرح بطريقة مبسّطة كيفية قراءة نتائج تحليل الdم وفهم أهم المؤشرات.','','lifestyle','published','manual','5:30',null,false,false, now() - interval '3 days'),

  ('news','مجموعة الموسى الطبية تستحوذ على 3 عيادات بـ12 مليون دينار','almousa-acquisition',
   'صفقة توسّع حضور المجموعة في السوق المحلي.','أعلنت مجموعة الموسى الطبية استحواذها على 3 عيادات بقيمة 12 مليون دينار، في صفقة توسّع حضورها بالسوق المحلي.','','health-economy','published','manual',null,2,false,false, now() - interval '1 day'),

  ('news','استثمار خليجي بـ50 مليون دولار في التقنية الصحية الكويتية','gulf-healthtech-investment',
   'تمويل يستهدف شركات التقنية الصحية الناشئة.','جذبت الكويت استثماراً خليجياً بقيمة 50 مليون دولار في قطاع التقنية الصحية، يستهدف الشركات الناشئة.','','health-economy','published','manual',null,2,false,false, now() - interval '2 days'),

  ('news','شراكة بين رويال حياة وشركة تأمين لتوسيع التغطية الصحية','royale-insurance-partnership',
   'اتفاقية لتوسيع التغطية وخفض التكاليف على المرضى.','أبرمت مستشفى رويال حياة شراكة مع شركة تأمين لتوسيع التغطية الصحية وخفض التكاليف على المرضى.','','health-economy','published','manual',null,2,false,false, now() - interval '3 days'),

  ('investigation','رحلة المريض الكويتي بين القطاعين العام والخاص','patient-journey-investigation',
   'تحقيق موسّع يتتبع مسار العلاج، أوقات الانتظار، والتكلفة — بالأرقام والشهادات.','تحقيق موسّع يتتبع رحلة المريض الكويتي بين القطاعين العام والخاص، من حيث مسار العلاج وأوقات الانتظار والتكلفة، مدعوماً بالأرقام وشهادات المرضى.','تحقيق يرصد الفجوات بين القطاعين العام والخاص في رحلة العلاج: أوقات الانتظار، التكلفة، وجودة الخدمة.','investigations','published','manual',null,12,false,false, now() - interval '2 days'),

  ('investigation','لماذا يسافر الكويتيون للعلاج بالخارج؟','why-travel-abroad-treatment',
   'الأسباب الكامنة خلف السياحة العلاجية ووجهاتها المفضّلة.','تحقيق يستعرض الأسباب التي تدفع الكويتيين للسفر بحثاً عن العلاج بالخارج، والوجهات المفضّلة، والتكاليف المترتبة.','','investigations','published','manual',null,8,false,false, now() - interval '4 days'),

  ('article','5 عادات صباحية تحسّن صحتك النفسية','morning-habits-mental-health',
   'عادات بسيطة تبدأ بها يومك لتعزيز صحتك النفسية.','خمس عادات صباحية بسيطة يمكن أن تحسّن صحتك النفسية وتمنحك طاقة أفضل خلال اليوم.','','lifestyle','published','manual',null,4,false,false, now() - interval '1 day'),

  ('article','دليل التغذية في الصيف الخليجي','gulf-summer-nutrition',
   'نصائح غذائية للتعامل مع حرارة الصيف الخليجي.','دليل عملي للتغذية الصحية خلال الصيف الخليجي، يشمل الترطيب والأطعمة المناسبة للحرارة المرتفعة.','','lifestyle','published','manual',null,5,false,false, now() - interval '2 days'),

  ('article','تمارين بسيطة تمارسها في المكتب','office-exercises',
   'حركات سريعة تقلل آثار الجلوس الطويل.','مجموعة تمارين بسيطة يمكن ممارستها في المكتب لتقليل آثار الجلوس الطويل وتحسين الدورة الدموية.','','lifestyle','published','manual',null,3,false,false, now() - interval '3 days'),

  ('news','إطلاق أكبر مدينة طبية متكاملة في الرياض','riyadh-medical-city',
   'المشروع يضم عدة مستشفيات تخصصية ومراكز أبحاث.','أعلنت السعودية إطلاق أكبر مدينة طبية متكاملة في الرياض، تضم مستشفيات تخصصية ومراكز أبحاث متقدمة.','','gulf','published','manual',null,2,false,false, now() - interval '1 day'),

  ('news','نتائج واعدة لعلاج جيني جديد في أبوظبي','abudhabi-gene-therapy',
   'تجارب سريرية تُظهر نتائج مشجّعة لعلاج جيني.','أظهرت تجارب سريرية في أبوظبي نتائج واعدة لعلاج جيني جديد يستهدف عدداً من الأمراض الوراثية.','','gulf','published','manual',null,2,false,false, now() - interval '2 days'),

  ('news','منظمة الصحة العالمية تحذّر من سلالة إنفلونزا جديدة','who-flu-warning',
   'المنظمة تدعو لرفع جاهزية الأنظمة الصحية.','حذّرت منظمة الصحة العالمية من سلالة إنفلونزا جديدة، داعيةً الدول إلى رفع جاهزية أنظمتها الصحية.','','world','published','manual',null,2,false,false, now() - interval '1 day')
on conflict (slug) do nothing;

-- Sources / references for a few items
insert into public.content_sources (content_id, label, url)
select id, 'وزارة الصحة الكويتية', 'https://www.moh.gov.kw' from public.content where slug = 'jaber-heart-expansion';
insert into public.content_sources (content_id, label, url)
select id, 'World Health Organization', 'https://www.who.int' from public.content where slug = 'who-flu-warning';
insert into public.content_sources (content_id, label, url)
select id, 'Reuters Health', 'https://www.reuters.com/business/healthcare-pharmaceuticals' from public.content where slug = 'abudhabi-gene-therapy';
insert into public.content_sources (content_id, label, url)
select id, 'تقرير سلمى الخاص', null from public.content where slug = 'patient-journey-investigation';
insert into public.content_sources (content_id, label, url)
select id, 'CDC', 'https://www.cdc.gov' from public.content where slug = 'heart-attack-vs-stroke';