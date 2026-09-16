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
  slide.addText("نبض NABD  |  طبقة التحقق من أحداث التسرب في شبكات المياه", rtl({ x: 0.6, y: H - 0.45, w: 8, h: 0.3, fontSize: 9, color: MUTED, align: "right", margin: 0 }));
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
  s.addText("نبض", rtl({ x: 0.8, y: 1.4, w: W - 1.6, h: 1.4, fontSize: 66, bold: true, color: WHITE, align: "right", margin: 0 }));
  s.addText("NABD  •  طبقة التحقق: من إنذار إلى قرار مسنود بدليل ودرجة ثقة", rtl({ x: 0.8, y: 2.8, w: W - 1.6, h: 0.6, fontSize: 20, color: "CADCFC", align: "right", margin: 0 }));
  s.addText([
    { text: "بيان المشكلة المعتمد", options: { breakLine: true } },
    { text: "خريطة التعاطف", options: { breakLine: true } },
    { text: "نموذج العمل التجاري", options: {} },
  ], rtl({ x: 0.8, y: 3.9, w: 6, h: 1.7, fontSize: 18, color: WHITE, align: "right", margin: 0, paraSpaceAfter: 8 }));
  s.addText("النسخة الثانية — بعد الجلسة الاستشارية مع م. عماد (شركة المياه الوطنية)", rtl({ x: 0.8, y: 6.05, w: W - 1.6, h: 0.4, fontSize: 12, color: MINT, align: "right", margin: 0 }));
  s.addText("تحدي التقنيات الرقمية والذكاء الاصطناعي والبنية التحتية الذكية للمياه", rtl({ x: 0.8, y: 6.5, w: W - 1.6, h: 0.4, fontSize: 12, color: "CADCFC", align: "right", margin: 0 }));
}

// ---------- Slide 2: Positioning — what already exists vs. where NABD sits ----------
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  title(s, "أين تقع نبض؟ لا نكرر الموجود", "المشغّل يملك منذ سنوات أنظمة كشف ومتابعة؛ الفجوة ليست في القياس بل في التحقق");
  const y = 1.75, h = 3.55, cw = (W - 1.2 - 0.3) / 2;
  card(s, W - 0.6 - cw, y, cw, h, "موجود أصلاً لدى المشغّل — خارج نطاقنا", [
    "أنظمة كشف التسرب (Leak Detection) وأجهزة وحساسات موزعة في الشبكة",
    "منصات متابعة الفاقد غير المحاسب (NRW) ونسب الفقد اللحظية على مستوى المناطق",
    "التوأم الرقمي والخرائط الرقمية (Digital Twin / Digital Mapping)",
    "أوامر العمل للتسريبات والانكسارات، وبيانات تصل إلى مستوى محابس العزل",
  ], { bodySize: 12, fill: SAND, headColor: MUTED });
  card(s, 0.6, y, cw, h, "الفجوة التي تملؤها نبض", [
    "كل حدث مرشح يصل اليوم كإنذار أو انحراف — بلا درجة ثقة ولا دليل يفسر سببه",
    "لا تمييز منهجي بين: انكسار مؤكد / عطل في الحساس / تغير طبيعي في الطلب",
    "لا قراءة للتوقيع الهيدروليكي المحلي حول موقع الحدث لدعم أو نفي الفرضية",
    "المسار المقترح: دليل ← درجة ثقة ← تحقق ← قرار (Evidence → Confidence → Verification → Decision)",
  ], { bodySize: 12, fill: LIGHT, headColor: NAVY });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 5.5, w: W - 1.2, h: 1.25, fill: { color: NAVY }, line: { color: NAVY }, rectRadius: 0.12 });
  s.addText("حدود النطاق الفني (مصححة بعد الجلسة الاستشارية)", rtl({ x: 0.9, y: 5.62, w: W - 1.8, h: 0.35, fontSize: 13, bold: true, color: MINT, align: "right", margin: 0 }));
  s.addText([
    { text: "أجهزة كشف التسرب والضغط للقراءة فقط (Read-only) باتصال أحادي الاتجاه ولا تستقبل أوامر — فلا يقوم الحل على فرضية التلاعب المباشر بالحساس.", options: { breakLine: true } },
    { text: "القياسات وقراءات الحساسات على IT، والتحكم على OT — ونبض تعمل على بيانات القياس فقط، بلا أي تحكم أو أوامر إلى المعدات.", options: {} },
  ], rtl({ x: 0.9, y: 5.98, w: W - 1.8, h: 0.7, fontSize: 11.5, color: WHITE, align: "right", valign: "top", margin: 0 }));
  footer(s, 2);
}

// ---------- Slide 3: Problem statement (who / what / where-when) ----------
{
  const s = pres.addSlide();
  s.background = { color: SAND };
  title(s, "بيان المشكلة المعتمد (1/3)", "من يعاني؟ ما المشكلة تحديداً؟ أين ومتى تحدث؟");
  const y = 1.75, h = 4.9, w = 3.85, gap = 0.3, x0 = 0.6;
  // Right-to-left order: first card on the right
  card(s, x0 + 2 * (w + gap), y, w, h, "من يعاني من المشكلة؟", [
    "فرق تشغيل وصيانة شبكات التوزيع التي تتلقى الأحداث وتقرر إرسال الفرق الميدانية",
    "غرف التحكم ومحللو الفاقد الذين يبنون مؤشرات NRW على قراءات قد تكون غير سليمة",
    "المشتركون: تأخر معالجة الانكسار الحقيقي يعني انقطاعاً أو فاتورة مرتفعة",
    "الجهة المشغلة: كلفة زيارات ميدانية لا ينتج عنها تسرب مؤكد",
  ], { bodySize: 12 });
  card(s, x0 + (w + gap), y, w, h, "ما المشكلة تحديداً؟", [
    "(وصف الظاهرة لا الحل) الحدث المرشح يصل إلى متخذ القرار دون درجة ثقة ودون دليل يفسر سببه",
    "لا يوجد تمييز منهجي بين انكسار مؤكد، وعطل في الحساس، وتغير طبيعي في الطلب",
    "الحكم يعتمد على خبرة الشخص المناوب، فتتفاوت القرارات على الحدث نفسه",
    "النتيجة: جهد ميداني يُصرف على أحداث غير مؤكدة، وأحداث حقيقية تنتظر في الطابور",
  ], { bodySize: 12 });
  card(s, x0, y, w, h, "أين ومتى تحدث؟", [
    "المرحلة: اللحظة الفاصلة بين رصد الحدث وإصدار أمر العمل — لا في القياس ولا في التنفيذ",
    "الموقع: شبكات التوزيع ومحيط نقطة الانكسار؛ الأثر محلي عند الموقع وما حوله لا على مستوى المنطقة أو المضخة",
    "الظروف: على مدار الساعة، وتشتد وقت ذروة الطلب حين تتشابه إشارة الانكسار مع التغير الطبيعي",
    "تشتد كذلك عند تقادم الحساس أو انحراف معايرته",
  ], { bodySize: 12 });
  footer(s, 3);
}

// ---------- Slide 4: Five whys ----------
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  title(s, "بيان المشكلة المعتمد (2/3): الأسباب الجذرية", "أسلوب \"لماذا؟\" خمس مرات");
  const whys = [
    ["لماذا يستمر الفاقد الفني رغم وجود أنظمة الكشف ومتابعة NRW؟", "لأن جزءاً من الأحداث المرشحة يتأخر التحقق منه فتتأخر المعالجة، وجزءاً آخر يُصرف عليه جهد ميداني دون تسرب فعلي."],
    ["لماذا يتأخر التحقق أو يُصرف الجهد بلا نتيجة؟", "لأن الحدث يصل إلى الفريق كإنذار أو انحراف رقمي، دون درجة ثقة ودون دليل يفسر سببه."],
    ["لماذا لا توجد درجة ثقة مرفقة بالحدث؟", "لأن الأنظمة القائمة تقيس وتعرض (تدفق، ضغط، نسب فقد) لكنها لا تفسّر: لا تربط الحدث بحالة الحساس نفسه ولا بسلوك جيرانه."],
    ["لماذا لا يتم هذا الربط؟", "لأنه يتطلب نموذجاً لانتشار أثر الانكسار محلياً حول موقعه عبر أقرب الحساسات، ونموذجاً لصحة الحساس — وكلاهما يُبنى على سلوك الشبكة الفعلي."],
    ["لماذا لم يُبنَ هذا النموذج؟", "لغياب طبقة تحليلية مستقلة تُعاير على البيانات التاريخية الحقيقية للمشغّل، وتتكامل معه بوضع قراءة فقط دون تكرار أنظمته."],
  ];
  const rowH = 0.92, y0 = 1.7;
  whys.forEach(([q, a], i) => {
    const y = y0 + i * (rowH + 0.1);
    const fill = i === 4 ? LIGHT : WHITE;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: W - 1.2, h: rowH, fill: { color: fill }, line: { color: i === 4 ? MINT : "D5E3EA", width: i === 4 ? 1.5 : 0.75 }, rectRadius: 0.1 });
    pill(s, W - 0.6 - 0.75, y + (rowH - 0.55) / 2, 0.55, 0.55, String(i + 1));
    s.addText(q, rtl({ x: W - 0.6 - 0.95 - 4.1, y: y + 0.1, w: 4.1, h: rowH - 0.2, fontSize: 12, bold: true, color: NAVY, align: "right", valign: "middle", margin: 0 }));
    s.addText(a, rtl({ x: 0.8, y: y + 0.1, w: W - 1.2 - 0.95 - 4.1 - 0.4, h: rowH - 0.2, fontSize: 11.5, color: INK, align: "right", valign: "middle", margin: 0 }));
  });
  s.addText("السبب الجذري: غياب طبقة تحقق تحوّل الحدث إلى قرار مسنود بدليل ودرجة ثقة، مُعايَرة على بيانات الشبكة الحقيقية", rtl({ x: 0.6, y: 6.85, w: W - 1.2, h: 0.35, fontSize: 12, bold: true, color: TEAL, align: "right", margin: 0 }));
  footer(s, 4);
}

// ---------- Slide 5: Impact + final statement ----------
{
  const s = pres.addSlide();
  s.background = { color: SAND };
  title(s, "بيان المشكلة المعتمد (3/3): الأثر والصيغة النهائية", "ماذا يترتب على بقاء المشكلة دون حل؟");
  const stats = [
    ["زيارات بلا نتيجة", "كل حدث غير مؤكد يُرسل له فريق = ساعات عمل ومركبات وكلفة تشغيل بلا مقابل"],
    ["زمن حتى القرار", "الانكسار الحقيقي ينتظر في طابور مزدحم بأحداث لم يُتحقق منها"],
    ["قراءات غير سليمة", "عطل الحساس غير المكتشف يلوّث مؤشرات الفاقد ويقود إلى قرارات مبنية على رقم خاطئ"],
    ["ثقة الفرق", "تكرار الإنذارات غير المؤكدة يدفع الفرق لتجاهلها — فيضيع الإنذار الصحيح بينها"],
  ];
  const cw = 2.9, gap = 0.25, y = 1.7, ch = 2.1;
  stats.forEach(([big, small], i) => {
    const x = W - 0.6 - cw - i * (cw + gap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: WHITE }, line: { color: "D5E3EA", width: 0.75 }, rectRadius: 0.12,
      shadow: { type: "outer", color: "000000", blur: 4, offset: 1.5, angle: 90, opacity: 0.10 } });
    s.addText(big, rtl({ x: x + 0.2, y: y + 0.2, w: cw - 0.4, h: 0.75, fontSize: 19, bold: true, color: TEAL, align: "right", margin: 0 }));
    s.addText(small, rtl({ x: x + 0.2, y: y + 0.95, w: cw - 0.4, h: 1.05, fontSize: 11, color: INK, align: "right", valign: "top", margin: 0 }));
  });
  s.addText("تُقاس هذه المحاور كمياً من بيانات المشغّل الحقيقية (أوامر العمل السابقة ونتائجها الميدانية) — ولا تُقدَّر بأرقام افتراضية قبل الحصول عليها.", rtl({ x: 0.6, y: 3.95, w: W - 1.2, h: 0.4, fontSize: 12, color: MUTED, align: "right", margin: 0 }));
  // Final statement banner
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 4.5, w: W - 1.2, h: 2.3, fill: { color: NAVY }, line: { color: NAVY }, rectRadius: 0.12 });
  s.addText("صيغة البيان النهائية", rtl({ x: 0.9, y: 4.65, w: W - 1.8, h: 0.4, fontSize: 14, bold: true, color: MINT, align: "right", margin: 0 }));
  s.addText([
    { text: "يعاني " }, { text: "فرق تشغيل وصيانة شبكات المياه", options: { bold: true, color: MINT } },
    { text: " من " }, { text: "وصول أحداث التسرب المرشحة إليهم دون درجة ثقة أو دليل يميز الانكسار المؤكد عن عطل الحساس عن التغير الطبيعي في الطلب", options: { bold: true, color: MINT } },
    { text: " عند " }, { text: "اللحظة الفاصلة بين رصد الحدث وإصدار أمر العمل", options: { bold: true, color: MINT } },
    { text: " بسبب " }, { text: "غياب طبقة تحقق تقرأ التوقيع الهيدروليكي المحلي حول موقع الحدث وحالة الحساس، مُعايَرة على بيانات الشبكة الحقيقية", options: { bold: true, color: MINT } },
    { text: "، مما يؤدي إلى " }, { text: "زيارات ميدانية بلا نتيجة، وتأخر معالجة الانكسارات الحقيقية، وتلوّث مؤشرات الفاقد بقراءات غير سليمة، وتآكل ثقة الفرق بالإنذارات.", options: { bold: true, color: MINT } },
  ], rtl({ x: 0.9, y: 5.05, w: W - 1.8, h: 1.65, fontSize: 13.5, color: WHITE, align: "right", valign: "top", margin: 0, lineSpacingMultiple: 1.15 }));
  footer(s, 5);
}

// ---------- Slide 6: Empathy map ----------
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  title(s, "خريطة التعاطف Empathy Map", "الشريحة المستهدفة: مدير/مشرف تشغيل وصيانة شبكة توزيع لدى مشغّل يملك أصلاً أنظمة كشف ومتابعة فاقد");
  const y0 = 1.65, cw = (W - 1.2 - 0.25) / 2, ch = 1.65, gap = 0.22;
  const blocks = [
    ["ماذا يقول؟", ["\"عندي أنظمة كشف ومنصات فاقد — ما أحتاج نظاماً جديداً يعرض لي نفس الشيء\"", "\"كيف أعرف أن هذا الحدث انكسار فعلي وليس عطلاً في الحساس؟\"", "\"لا أرسل فريقاً بناءً على رقم لا أعرف من أين جاء\""]],
    ["ماذا يفكر؟", ["الأولويات: قرار أسرع وأدق، وخفض الزيارات بلا نتيجة", "المخاوف: نظام يزيد الإنذارات بدل أن يرتبها، أو يلمس بيئة التشغيل", "الطموح: كل حدث يصل ومعه سببه ودرجة ثقته، وقابل للتوسع"]],
    ["ماذا يفعل؟", ["يوازن يدوياً بين الأحداث المرشحة معتمداً على خبرة المناوب", "يرسل فريقاً للتحقق الميداني حين يتعذر الحسم من المكتب", "يراجع أوامر العمل ونتائجها بأثر رجعي لاستخلاص الدروس"]],
    ["ماذا يشعر؟", ["إحباط من الأحداث التي لا ينتج عنها تسرب بعد صرف الجهد", "قلق من انكسار حقيقي تأخر لأنه كان مدفوناً بين أحداث غير مؤكدة", "ضغط مستمر لتحقيق مؤشرات الأداء بموارد ميدانية محدودة"]],
  ];
  blocks.forEach(([h, items], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = col === 0 ? W - 0.6 - cw : 0.6;
    card(s, x, y0 + row * (ch + gap), cw, ch, h, items, { bodySize: 11, fill: row === 0 ? LIGHT : WHITE });
  });
  const y2 = y0 + 2 * (ch + gap), ch2 = 1.55;
  card(s, W - 0.6 - cw, y2, cw, ch2, "الآلام Pains", [
    "زيارات ميدانية لا ينتج عنها تسرب مؤكد، وتأخر الانكسار الحقيقي في طابور الأحداث",
    "عطل حساس غير مكتشف يلوّث مؤشرات الفاقد؛ وقرارات تتفاوت بتفاوت خبرة المناوب",
  ], { bodySize: 11, headColor: "B85042" });
  card(s, 0.6, y2, cw, ch2, "المكاسب Gains", [
    "كل حدث يصل بتصنيف ودرجة ثقة ودليل يسنده، فيُرتَّب الجهد الميداني حسب الأولوية",
    "اكتشاف مبكر لانحراف الحساس، وتكامل قراءة فقط لا يلمس الأنظمة القائمة؛ يقيس النجاح بنسبة الزيارات المثمرة وزمن الوصول للقرار",
  ], { bodySize: 11, headColor: "2C5F2D" });
  footer(s, 6);
}

// ---------- Slide 7: Business Model Canvas ----------
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
    "المشغّل نفسه (شركة المياه الوطنية) بصفته مالك البيانات وصاحب حالة الاستخدام",
    "مزودو منصات الكشف والفاقد والتوأم الرقمي القائمة — تكامل لا استبدال",
    "موردو الحساسات وأنظمة القياس القائمة في الشبكة",
    "الجامعات ومراكز البحث لمعايرة النماذج الهيدروليكية",
    "الجهات التنظيمية فيما يخص حوكمة مشاركة البيانات",
  ]);
  // Column 1: Key activities / resources
  const halfH = (midH - gap) / 2;
  bmc(xCol(1), top, colW, halfH, "الأنشطة الرئيسية", [
    "معايرة نماذج التحقق على البيانات التاريخية وأوامر العمل",
    "نمذجة التوقيع الهيدروليكي المحلي عبر أقرب الحساسات",
    "نمذجة صحة الحساس لكشف الانحراف والعطل",
    "تكامل قراءة فقط مع أنظمة القياس على IT",
  ]);
  bmc(xCol(1), top + halfH + gap, colW, halfH, "الموارد الرئيسية", [
    "بيانات الشبكة بموجب اتفاقية مشاركة بيانات",
    "خوارزميات التصنيف ودرجة الثقة وكشف عطل الحساس",
    "فريق هيدروليكا وعلوم بيانات وتكامل أنظمة",
    "سجل أوامر العمل كمرجع لقياس دقة النموذج",
  ]);
  // Column 2: Value proposition
  card(s, xCol(2), top, colW, midH, "القيمة المقترحة", [
    "لا نكرر الكشف — نضيف الثقة: كل حدث مرشح يصل بتصنيف ودرجة ثقة والدليل الذي يسنده",
    "تمييز الانكسار المؤكد عن عطل الحساس عن التغير الطبيعي في الطلب قبل إصدار أمر العمل",
    "ترتيب الجهد الميداني حسب الأولوية بدل التعامل مع الأحداث كقائمة متساوية",
    "تكامل قراءة فقط فوق الأنظمة القائمة، بلا تحكم وبلا تعديل عليها",
    "لماذا نتفوق: منطق تحقق مُعايَر على بيانات الشبكة الفعلية لا على فرضيات عامة",
  ], { bodySize: 9, headSize: 11.5, fill: LIGHT, headColor: NAVY });
  // Column 3: Customer relationships / channels
  bmc(xCol(3), top, colW, halfH, "العلاقات مع العملاء", [
    "شراكة تشغيلية مع غرفة التحكم وفرق الصيانة",
    "تقرير دوري: دقة التصنيف ونسبة الزيارات المثمرة",
    "مراجعة مشتركة لكل حدث اختلف فيه النموذج مع الواقع",
    "حسابات مدارة ودعم فني متخصص",
  ]);
  bmc(xCol(3), top + halfH + gap, colW, halfH, "القنوات", [
    "برامج الابتكار والتحديات الوطنية",
    "إثبات مفهوم على بيانات تاريخية لمنطقة واحدة",
    "المناقصات المباشرة مع جهات التشغيل",
    "شركاء التكامل ومزودو المنصات القائمة",
  ]);
  // Column 4 (left): Customer segments
  bmc(xCol(4), top, colW, midH, "شرائح العملاء", [
    "الشريحة الأولى: مشغّلو شبكات توزيع يملكون بنية قياس وحساسات قائمة وسجل أوامر عمل",
    "غرف التحكم وإدارات الفاقد التي تتخذ قرار الإرسال الميداني",
    "لاحقاً: المدن الصناعية وشركات التوزيع الإقليمية والمشغلون الخاصون",
  ]);
  // Bottom row
  const by = top + midH + gap, bw = (totalW - gap) / 2;
  bmc(W - 0.6 - bw, by, bw, bottomH, "هيكل التكاليف", [
    "ثابتة: تطوير الخوارزميات ومعايرتها، رواتب الفريق المتخصص، بيئة التشغيل والامتثال",
    "متغيرة: التكامل مع أنظمة كل عميل، جهد المعايرة لكل منطقة، التدريب والدعم الميداني",
  ]);
  bmc(0.6, by, bw, bottomH, "مصادر الإيرادات", [
    "ترخيص سنوي للمنصة + عقد خدمة مُدارة (Managed Service)",
    "رسوم التكامل والمعايرة الأولية لكل منطقة، ونموذج مرتبط بالأداء: نسبة من وفر الزيارات غير المثمرة وتحسن زمن المعالجة",
  ]);
  footer(s, 7);
}

pres.writeFile({ fileName: "NABD_Problem_Empathy_BMC.pptx" }).then((f) => console.log("wrote", f));
