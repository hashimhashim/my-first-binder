const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.rtlMode = true;
pres.lang = "ar-SA";

// Palette: deep water navy dominant, teal support, mint accent
const NAVY = "0B3C5D", TEAL = "1C7293", MINT = "3FB8AF", INK = "1F2933",
      MUTED = "5B6B7A", LIGHT = "EAF4F7", WHITE = "FFFFFF", SAND = "F4F7F9", AMBER = "E8A33D";
const FONT = "Arial";
const W = 13.33, H = 7.5;

const rtl = (extra = {}) => ({ fontFace: FONT, rtlMode: true, lang: "ar-SA", isTextBox: true, ...extra });

function title(slide, text, sub) {
  slide.addText(text, rtl({ x: 0.6, y: 0.35, w: W - 1.2, h: 0.8, fontSize: 32, bold: true, color: NAVY, align: "right", margin: 0 }));
  if (sub) slide.addText(sub, rtl({ x: 0.6, y: 1.1, w: W - 1.2, h: 0.4, fontSize: 14, color: MUTED, align: "right", margin: 0 }));
}
function footer(slide, n) {
  slide.addText("نبض NABD  |  حل كشف الفاقد والتسربات في شبكات المياه", rtl({ x: 0.6, y: H - 0.45, w: 8, h: 0.3, fontSize: 9, color: MUTED, align: "right", margin: 0 }));
  slide.addText(String(n), rtl({ x: W - 1.2, y: H - 0.45, w: 0.6, h: 0.3, fontSize: 9, color: MUTED, align: "left", margin: 0 }));
}
function card(slide, x, y, w, h, head, body, opts = {}) {
  const fill = opts.fill || WHITE, headColor = opts.headColor || TEAL, bodySize = opts.bodySize || 12;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill }, line: { color: "D5E3EA", width: 0.75 }, rectRadius: 0.12,
    shadow: { type: "outer", color: "000000", blur: 4, offset: 1.5, angle: 90, opacity: 0.10 } });
  slide.addText(head, rtl({ x: x + 0.2, y: y + 0.12, w: w - 0.4, h: 0.4, fontSize: opts.headSize || 14, bold: true, color: headColor, align: "right", margin: 0 }));
  const items = Array.isArray(body) ? body : [body];
  const runs = items.map((t, i) => ({ text: t, options: { bullet: items.length > 1 ? { indent: 12 } : false, breakLine: i < items.length - 1, paraSpaceAfter: 4 } }));
  slide.addText(runs, rtl({ x: x + 0.2, y: y + 0.55, w: w - 0.4, h: h - 0.7, fontSize: bodySize, color: INK, align: "right", valign: "top", margin: 0 }));
}
function pill(slide, x, y, w, h, n) {
  slide.addShape(pres.shapes.OVAL, { x, y, w, h, fill: { color: MINT }, line: { color: MINT } });
  slide.addText(n, rtl({ x, y, w, h, fontSize: 14, bold: true, color: NAVY, align: "center", valign: "middle", margin: 0 }));
}

// ---------- Slide 1: Title ----------
{
  const s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.shapes.OVAL, { x: -2.5, y: 3.6, w: 7, h: 7, fill: { color: TEAL, transparency: 60 }, line: { color: TEAL, transparency: 60 } });
  s.addShape(pres.shapes.OVAL, { x: 9.5, y: -3, w: 6.5, h: 6.5, fill: { color: MINT, transparency: 75 }, line: { color: MINT, transparency: 75 } });
  s.addText("نبض", rtl({ x: 0.8, y: 1.5, w: W - 1.6, h: 1.4, fontSize: 66, bold: true, color: WHITE, align: "right", margin: 0 }));
  s.addText("NABD  •  منصة كشف الفاقد المائي وطبقة الثقة لأنظمة التشغيل", rtl({ x: 0.8, y: 2.9, w: W - 1.6, h: 0.6, fontSize: 20, color: "CADCFC", align: "right", margin: 0 }));
  s.addText([
    { text: "بيان المشكلة المعتمد", options: { breakLine: true } },
    { text: "خريطة التعاطف", options: { breakLine: true } },
    { text: "نموذج العمل التجاري", options: {} },
  ], rtl({ x: 0.8, y: 4.0, w: 6, h: 1.8, fontSize: 18, color: WHITE, align: "right", margin: 0, paraSpaceAfter: 8 }));
  s.addText("تحدي التقنيات الرقمية والذكاء الاصطناعي والبنية التحتية الذكية للمياه", rtl({ x: 0.8, y: 6.4, w: W - 1.6, h: 0.4, fontSize: 12, color: "CADCFC", align: "right", margin: 0 }));
}

// ---------- Slide 2: Problem statement (who / what / where-when) ----------
{
  const s = pres.addSlide();
  s.background = { color: SAND };
  title(s, "بيان المشكلة المعتمد (1/3)", "من يعاني؟ ما المشكلة تحديداً؟ أين ومتى تحدث؟");
  const y = 1.75, h = 4.9, w = 3.85, gap = 0.3, x0 = 0.6;
  // Right-to-left order: first card on the right
  card(s, x0 + 2 * (w + gap), y, w, h, "من يعاني من المشكلة؟", [
    "جهات تشغيل وإدارة شبكات المياه (مثل الشركة الوطنية للمياه) والمدن الصناعية",
    "فرق التشغيل والصيانة وإدارات الأمن السيبراني للأنظمة التشغيلية (OT)",
    "المشتركون (المستفيد النهائي) الذين يتحملون فواتير مرتفعة بسبب تسربات لا يرونها",
    "المجتمع والبيئة: موارد مائية شحيحة وطاقة ضخ مهدرة",
  ], { bodySize: 12 });
  card(s, x0 + (w + gap), y, w, h, "ما المشكلة تحديداً؟", [
    "ارتفاع الفاقد غير المحاسب (NRW) بسبب تسربات غير مرئية لا تُكتشف إلا بعد ظهورها على السطح أو وصول شكوى",
    "الإنذارات الحالية لا تميز بين تسرب حقيقي، عطل حساس، أو تلاعب في بيانات أنظمة التحكم (PLC/RTU)",
    "زمن الاكتشاف يُقاس بالأيام والأسابيع، وتحديد الموقع يعتمد على البحث الميداني العشوائي",
    "ملاحظة: الوصف أعلاه يصف الظاهرة لا الحل",
  ], { bodySize: 12 });
  card(s, x0, y, w, h, "أين ومتى تحدث؟", [
    "المرحلة: نقل وتوزيع المياه، وداخل منشآت المشتركين",
    "الموقع: شبكات تتجاوز 134,000 كم على المستوى الوطني، مع تجربة تطبيقية مقترحة في الجبيل",
    "الظروف: على مدار الساعة، وتتفاقم مع تقادم الأصول، تذبذب الضغط ليلاً، وغياب المراقبة اللحظية لكل مقطع",
    "تظهر أيضاً عند مراجعة الفواتير المرتفعة (أكثر من 90% منها سببها تسربات فنية)",
  ], { bodySize: 12 });
  footer(s, 2);
}

// ---------- Slide 3: Five whys ----------
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  title(s, "بيان المشكلة المعتمد (2/3): الأسباب الجذرية", "أسلوب \"لماذا؟\" خمس مرات");
  const whys = [
    ["لماذا يرتفع الفاقد المائي؟", "بسبب تسربات فنية مستمرة في الشبكة والمنشآت الداخلية لا تُعالج في وقتها."],
    ["لماذا لا تُكتشف التسربات مبكراً؟", "لأن أغلبها غير مرئي، ولا توجد مراقبة لحظية لكل مقطع من الشبكة؛ الاعتماد على البلاغات والمظهر السطحي."],
    ["لماذا لا توجد مراقبة لحظية موثوقة؟", "لأن الأنظمة الحالية تجمع البيانات دون تحليل لحظي، وتولد إنذارات كاذبة كثيرة تفقد الفرق الثقة بها."],
    ["لماذا كثرة الإنذارات الكاذبة؟", "لغياب \"طبقة ثقة\" تتحقق من مصداقية القراءة وتميز بين التسرب الفعلي، عطل الحساس، أو التلاعب السيبراني."],
    ["لماذا تغيب طبقة الثقة؟", "لعدم وجود حل محلي مدمج يجمع التوأم الرقمي والذكاء الاصطناعي وأمن أنظمة التحكم في منصة واحدة تتكامل مع الأنظمة القائمة بوضع قراءة فقط."],
  ];
  const rowH = 0.92, y0 = 1.7;
  whys.forEach(([q, a], i) => {
    const y = y0 + i * (rowH + 0.1);
    const fill = i === 4 ? LIGHT : WHITE;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: W - 1.2, h: rowH, fill: { color: fill }, line: { color: i === 4 ? MINT : "D5E3EA", width: i === 4 ? 1.5 : 0.75 }, rectRadius: 0.1 });
    pill(s, W - 0.6 - 0.75, y + (rowH - 0.55) / 2, 0.55, 0.55, String(i + 1));
    s.addText(q, rtl({ x: W - 0.6 - 0.95 - 3.6, y: y + 0.12, w: 3.6, h: rowH - 0.24, fontSize: 13, bold: true, color: NAVY, align: "right", valign: "middle", margin: 0 }));
    s.addText(a, rtl({ x: 0.8, y: y + 0.1, w: W - 1.2 - 0.95 - 3.6 - 0.4, h: rowH - 0.2, fontSize: 12, color: INK, align: "right", valign: "middle", margin: 0 }));
  });
  s.addText("السبب الجذري: غياب طبقة ثقة تحليلية محلية تتكامل مع الأنظمة القائمة دون تعديلها", rtl({ x: 0.6, y: 6.85, w: W - 1.2, h: 0.35, fontSize: 12, bold: true, color: TEAL, align: "right", margin: 0 }));
  footer(s, 3);
}

// ---------- Slide 4: Impact + final statement ----------
{
  const s = pres.addSlide();
  s.background = { color: SAND };
  title(s, "بيان المشكلة المعتمد (3/3): الأثر والصيغة النهائية", "ماذا يترتب على بقاء المشكلة دون حل؟");
  const stats = [
    ["ملايين م³", "هدر سنوي؛ كل 1% خفض في الفاقد يعادل ملايين الأمتار المكعبة"],
    ["+90%", "من الفواتير المرتفعة سببها تسربات فنية، مما يولد شكاوى متكررة"],
    ["134,000 كم", "طول الشبكة الوطنية المعرضة لتسربات غير مرئية"],
    ["24/7", "تعرّض أنظمة التحكم (OT) لمخاطر التلاعب دون تحقق من القراءات"],
  ];
  const cw = 2.9, gap = 0.25, y = 1.7, ch = 2.1;
  stats.forEach(([big, small], i) => {
    const x = W - 0.6 - cw - i * (cw + gap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: WHITE }, line: { color: "D5E3EA", width: 0.75 }, rectRadius: 0.12,
      shadow: { type: "outer", color: "000000", blur: 4, offset: 1.5, angle: 90, opacity: 0.10 } });
    s.addText(big, rtl({ x: x + 0.2, y: y + 0.2, w: cw - 0.4, h: 0.8, fontSize: 30, bold: true, color: TEAL, align: "right", margin: 0 }));
    s.addText(small, rtl({ x: x + 0.2, y: y + 1.0, w: cw - 0.4, h: 1.0, fontSize: 11, color: INK, align: "right", valign: "top", margin: 0 }));
  });
  s.addText("تكاليف إضافية: بحث ميداني عشوائي، صيانة طارئة بدل تنبؤية، طاقة ضخ غير ضرورية، وأثر على سمعة الجهة المشغلة.", rtl({ x: 0.6, y: 3.95, w: W - 1.2, h: 0.4, fontSize: 12, color: MUTED, align: "right", margin: 0 }));
  // Final statement banner
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 4.5, w: W - 1.2, h: 2.3, fill: { color: NAVY }, line: { color: NAVY }, rectRadius: 0.12 });
  s.addText("صيغة البيان النهائية", rtl({ x: 0.9, y: 4.65, w: W - 1.8, h: 0.4, fontSize: 14, bold: true, color: MINT, align: "right", margin: 0 }));
  s.addText([
    { text: "يعاني " }, { text: "مشغلو شبكات المياه والمشتركون", options: { bold: true, color: MINT } },
    { text: " من " }, { text: "ارتفاع الفاقد غير المحاسب والتسربات غير المرئية التي تُكتشف متأخرة", options: { bold: true, color: MINT } },
    { text: " عند " }, { text: "مراحل نقل وتوزيع المياه وداخل المنشآت على مدار الساعة", options: { bold: true, color: MINT } },
    { text: " بسبب " }, { text: "غياب نظام رصد لحظي موثوق يميز بين التسرب الفعلي وأعطال الحساسات والتلاعب السيبراني", options: { bold: true, color: MINT } },
    { text: "، مما يؤدي إلى " }, { text: "هدر ملايين الأمتار المكعبة سنوياً، وارتفاع تكاليف التشغيل والصيانة، وفواتير مرتفعة وشكاوى متكررة، وتعريض البنية التحتية الحرجة لمخاطر أمنية.", options: { bold: true, color: MINT } },
  ], rtl({ x: 0.9, y: 5.05, w: W - 1.8, h: 1.65, fontSize: 14, color: WHITE, align: "right", valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));
  footer(s, 4);
}

// ---------- Slide 5: Empathy map ----------
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  title(s, "خريطة التعاطف Empathy Map", "الشريحة المستهدفة: مدير تشغيل وصيانة شبكة مياه، ومدير الأمن السيبراني للأنظمة التشغيلية (OT) لدى الجهة المشغلة");
  const y0 = 1.65, cw = (W - 1.2 - 0.25) / 2, ch = 1.65, gap = 0.22;
  const blocks = [
    ["ماذا يقول؟", ["\"نغرق في بلاغات التسرب والشكاوى المتكررة\"", "\"كيف نميز بين تسرب حقيقي وعطل في الحساس؟\"", "\"نريد حلاً لا يلمس أنظمتنا التشغيلية ولا يوقفها\""]],
    ["ماذا يفكر؟", ["الأولويات: خفض NRW، خفض التكاليف، الامتثال لضوابط الهيئة الوطنية للأمن السيبراني (OTCC)", "المخاوف: اختراق أنظمة التحكم، استمرار الهدر، تضرر سمعة الجهة", "الطموح: شبكة ذكية آمنة قابلة للتوسع وطنياً"]],
    ["ماذا يفعل؟", ["يرسل فرقاً ميدانية تفاعلياً بعد البلاغ أو ظهور التسرب", "يعتمد الصيانة الطارئة بدل التنبؤية", "يعالج شكاوى الفواتير يدوياً ويراجع التقارير الشهرية بأثر رجعي"]],
    ["ماذا يشعر؟", ["إحباط من الإنذارات الكاذبة والإرسال غير المبرر للفرق", "قلق دائم من اختراق سيبراني أو انهيار أصل حيوي", "ضغط مستمر لتحقيق مؤشرات الأداء وخفض الهدر"]],
  ];
  blocks.forEach(([h, items], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = col === 0 ? W - 0.6 - cw : 0.6;
    card(s, x, y0 + row * (ch + gap), cw, ch, h, items, { bodySize: 11, fill: row === 0 ? LIGHT : WHITE });
  });
  const y2 = y0 + 2 * (ch + gap), ch2 = 1.55;
  card(s, W - 0.6 - cw, y2, cw, ch2, "الآلام Pains", [
    "تكلفة البحث الميداني غير المبرر وصعوبة تحديد موقع التسرب بدقة",
    "خطر التلاعب بقراءات PLC/RTU، والانتقادات بسبب الهدر، وشكاوى المشتركين المستمرة",
  ], { bodySize: 11, headColor: "B85042" });
  card(s, 0.6, y2, cw, ch2, "المكاسب Gains", [
    "خفض ملموس للفاقد، وتوجيه الفرق لموقع محدد، وتحويل الصيانة إلى مجدولة تنبؤية",
    "امتثال كامل، تنبيه مبكر يرضي المشتركين، ومنصة محلية بمحتوى 100%؛ يقيس النجاح بنسبة NRW وزمن الاكتشاف",
  ], { bodySize: 11, headColor: "2C5F2D" });
  footer(s, 5);
}

// ---------- Slide 6: Business Model Canvas ----------
{
  const s = pres.addSlide();
  s.background = { color: SAND };
  title(s, "نموذج العمل التجاري Business Model Canvas");
  const top = 1.2, bottomH = 1.3, midH = 6.95 - top - 0.12 - bottomH; // rows
  const gap = 0.12, totalW = W - 1.2, colW = (totalW - 4 * gap) / 5;
  const xCol = (i) => W - 0.6 - colW - i * (colW + gap); // i=0 rightmost
  const bmc = (x, y, w, h, head, items) => card(s, x, y, w, h, head, items, { bodySize: 9, headSize: 11.5 });
  // Column 0 (right): Key partners
  bmc(xCol(0), top, colW, midH, "الشركاء الرئيسيون", [
    "جهات التشغيل والتنظيم (الشركة الوطنية للمياه، المدن الصناعية)",
    "الهيئة الوطنية للأمن السيبراني (الامتثال لـ OTCC-1)",
    "موردو الحساسات والعدادات الذكية (IoT)",
    "منصة أيجس Aegis السعودية كشريك تقني أساسي",
    "مراكز البحث والتطوير والجامعات المحلية",
  ]);
  // Column 1: Key activities / resources
  const halfH = (midH - gap) / 2;
  bmc(xCol(1), top, colW, halfH, "الأنشطة الرئيسية", [
    "بناء وصيانة التوأم الرقمي للشبكة",
    "تحليل لحظي للتدفق والضغط بالذكاء الاصطناعي لكشف الشذوذ",
    "تشغيل طبقة الثقة للتحقق من القراءات وأجهزة PLC/RTU",
    "تكامل آمن بوضع قراءة فقط (OPC-UA / Historian)",
  ]);
  bmc(xCol(1), top + halfH + gap, colW, halfH, "الموارد الرئيسية", [
    "منصة نبض المبنية على منصة Aegis العاملة",
    "خوارزميات كشف التسرب والتنبؤ بأعطال الأصول",
    "فريق OT وأمن سيبراني وعلوم بيانات",
    "بيانات الشبكة التاريخية واللحظية",
  ]);
  // Column 2: Value proposition
  card(s, xCol(2), top, colW, midH, "القيمة المقترحة", [
    "كشف التسرب خلال دقائق بدل أيام، مع تحديد الموقع المرجّح",
    "طبقة ثقة تميز التسرب الفعلي عن عطل الحساس أو التلاعب السيبراني قبل أي إجراء",
    "حل محلي 100% (On-prem) دون تعديل على الأنظمة القائمة",
    "خفض NRW وتكاليف الصيانة وطاقة الضخ، وحماية البنية التحتية الحرجة",
    "لماذا نتفوق: الجمع بين التوأم الرقمي وأمن OT في منصة واحدة محلية",
  ], { bodySize: 9, headSize: 11.5, fill: LIGHT, headColor: NAVY });
  // Column 3: Customer relationships / channels
  bmc(xCol(3), top, colW, halfH, "العلاقات مع العملاء", [
    "حسابات مدارة ودعم فني متخصص",
    "تقارير دورية: NRW، حالة الأصول، الحوادث",
    "شراكة في التحول الرقمي وأمن OT",
    "تنبيهات مباشرة للمشتركين (B2B2C)",
  ]);
  bmc(xCol(3), top + halfH + gap, colW, halfH, "القنوات", [
    "برامج الابتكار والتحديات الوطنية",
    "المناقصات المباشرة مع جهات التشغيل",
    "نموذج تجريبي قابل للتوسع (الجبيل)",
    "شركاء التكامل والموردون",
  ]);
  // Column 4 (left): Customer segments
  bmc(xCol(4), top, colW, midH, "شرائح العملاء", [
    "الشريحة الأولى: جهات تشغيل شبكات المياه في المدن الصناعية والكبرى (الجبيل أولاً)",
    "إدارات الأمن السيبراني والأنظمة التشغيلية في المرافق الحيوية",
    "لاحقاً: شركات التوزيع الإقليمية والمشغلون الخاصون",
  ]);
  // Bottom row
  const by = top + midH + gap, bw = (totalW - gap) / 2;
  bmc(W - 0.6 - bw, by, bw, bottomH, "هيكل التكاليف", [
    "ثابتة: تطوير البرمجيات والخوارزميات، رواتب الفريق المتخصص، تراخيص وشهادات الامتثال",
    "متغيرة: بنية On-prem لكل عميل، تكامل الحساسات، التدريب والدعم الميداني",
  ]);
  bmc(0.6, by, bw, bottomH, "مصادر الإيرادات", [
    "ترخيص البرمجيات + عقد خدمة وصيانة سنوي (Managed Service)",
    "رسوم التكامل الأولي والتدريب، ونموذج مرتبط بالأداء: نسبة من قيمة التوفير في الفاقد أو طاقة الضخ",
  ]);
  footer(s, 6);
}

pres.writeFile({ fileName: "NABD_Problem_Empathy_BMC.pptx" }).then((f) => console.log("wrote", f));
