/**
 * Best-effort gender from first name (Arabic + English).
 * Returns 'male' | 'female' | 'unknown'.
 */
const MALE = new Set(
  [
    'ahmed', 'ahmad', 'mohamed', 'mohammad', 'muhammad', 'mohammed', 'ali', 'omar', 'osama',
    'youssef', 'yousef', 'yusuf', 'hassan', 'hussein', 'hussain', 'karim', 'kareem', 'tamer',
    'tarek', 'tareq', 'mostafa', 'mustafa', 'mahmoud', 'ibrahim', 'khaled', 'khalid', 'amr',
    'amir', 'samir', 'sherif', 'sharif', 'walid', 'waleed', 'nabil', 'fady', 'fadi', 'ramy',
    'rami', 'hany', 'hani', 'bassem', 'basem', 'seif', 'saif', 'zyad', 'ziad', 'ziyad',
    'adam', 'john', 'michael', 'david', 'james', 'daniel', 'mark', 'paul', 'peter', 'thomas',
    'andrew', 'chris', 'christopher', 'joseph', 'matt', 'matthew', 'alex', 'alexander',
    'abdallah', 'abdullah', 'abdelrahman', 'abdel', 'hamza', 'yassin', 'yassine',
    'moaz', 'moaaz', 'hassan', 'hussein', 'sayed', 'said', 'saeed', 'fouad', 'fawzy', 'fawzi',
    'gamal', 'jamal', 'nasser', 'nasr', 'rafik', 'rafiq', 'sameh', 'sami', 'shady', 'shadi',
    'tarek', 'wael', 'waal', 'yahya', 'yasser', 'yaser', 'zaki', 'zakaria', 'ziad',
    'ehab', 'ihab', 'essam', 'issam', 'emad', 'imad', 'ashraf', 'atef', 'atif', 'bahaa',
    'basel', 'hazem', 'hossam', 'hosam', 'magdy', 'magdi', 'mamdouh', 'marwan', 'mina',
    'nagy', 'nagi', 'osman', 'othman', 'reda', 'ridha', 'sherif', 'taha', 'usama',
    // Arabic script
    'أحمد', 'احمد', 'محمد', 'محمود', 'علي', 'عمر', 'يوسف', 'حسن', 'حسين', 'كريم',
    'تامر', 'طارق', 'مصطفى', 'مصطفي', 'ابراهيم', 'إبراهيم', 'خالد', 'عمرو', 'أمير',
    'سمير', 'شريف', 'وليد', 'هاني', 'باسم', 'سيف', 'زياد', 'حمزة', 'ياسين', 'عبدالله',
    'عبدالله', 'سيد', 'سعيد', 'جمال', 'ناصر', 'وائل', 'ياسر', 'إيهاب', 'ايهاب', 'عصام',
    'عماد', 'أشرف', 'اشرف', 'حازم', 'حسام', 'مجدي', 'مروان', 'رضا', 'أسامة', 'اسامة',
  ].filter((n) => n !== 'mayar')
);

const FEMALE = new Set([
  'sara', 'sarah', 'salma', 'nada', 'nour', 'noor', 'mona', 'maha', 'mai', 'may', 'mariam',
  'maryam', 'mariem', 'miriam', 'fatma', 'fatima', 'aya', 'ayaat', 'huda', 'hoda', 'heba',
  'hiba', 'rana', 'rania', 'dina', 'diana', 'layla', 'leila', 'laila', 'yasmin', 'yasmeen',
  'yasmine', 'farah', 'jana', 'janae', 'malak', 'menna', 'mena', 'nermin', 'nermine',
  'shereen', 'sherine', 'reem', 'rim', 'rima', 'omnia', 'omneya', 'esraa', 'israa', 'isra',
  'nancy', 'nelly', 'noura', 'nora', 'emily', 'emma', 'olivia', 'sophia', 'isabella', 'mia',
  'amira', 'ameera', 'basma', 'basmah', 'doaa', 'doa', 'ghada', 'hala', 'hanan',
  'iman', 'eman', 'lina', 'lena', 'nadine', 'nadeen', 'samar', 'samira', 'zeinab', 'zainab',
  'zahra', 'zahraa', 'rawan', 'rowan', 'rovan', 'rouwan', 'passant', 'basant', 'passant',
  'joyce', 'jessica', 'jennifer', 'christine', 'christina', 'maria', 'marie', 'natalie',
  'nourhan', 'norhan', 'nouran', 'noran', 'shaimaa', 'shaima', 'shymaa', 'shimaa',
  'marwa', 'marwaa', 'maie', 'maia', 'maya', 'mya', 'hend', 'hind', 'hadeer', 'hadir',
  'habiba', 'habibah', 'logy', 'logy', 'logein', 'logain', 'lojain', 'lujain',
  'ganna', 'jana', 'gehad', 'jihad', 'donia', 'doniaa', 'dunya', 'tasneem', 'tasnim',
  'youmna', 'yomna', 'yumna', 'carmen', 'carole', 'carol', 'veronica', 'victoria',
  'bayan', 'bayan', 'bushra', 'bosy', 'bossy', 'bosey', 'sally', 'sandy', 'sandra',
  'wafaa', 'wafa', 'wessam', 'wesam', 'yasmeen', 'yara', 'yomna',
  // Arabic script
  'سارة', 'ساره', 'سلمى', 'سلمي', 'ندى', 'ندي', 'نور', 'منى', 'مني', 'مها', 'مي',
  'مريم', 'فاطمة', 'فاطمه', 'آية', 'اية', 'آيات', 'ايات', 'هدى', 'هدي', 'هبة', 'هبه',
  'رنا', 'رانيا', 'دينا', 'ليلى', 'ليلي', 'ياسمين', 'فرح', 'جنى', 'جني', 'ملاك',
  'منة', 'منه', 'منّة', 'نرمين', 'شيرين', 'ريم', 'أمنية', 'امنية', 'إسراء', 'اسراء',
  'نورا', 'نورة', 'اميرة', 'بسملة', 'دعاء', 'غادة', 'غاده', 'هالة', 'هاله', 'حنان',
  'إيمان', 'ايمان', 'لينا', 'نادين', 'سمر', 'سميرة', 'زينب', 'زهراء', 'روان',
  'شيماء', 'مروة', 'مروه', 'هند', 'حبيبّة', 'حبيبة', 'دنيا', 'تسنيم', 'يمنى', 'يمني',
  'يافا', 'يارا', 'وفاء', 'وفاه', 'بسمة', 'بسمه',
]);

export function inferGenderFromName(fullName) {
  if (!fullName || typeof fullName !== 'string') return 'unknown';
  const first = fullName
    .trim()
    .split(/\s+/)[0]
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\u0600-\u06ff]/g, '');
  if (!first) return 'unknown';

  // Common Arabic transliteration prefixes
  const normalized = first.replace(/^al-/, '').replace(/^el-/, '');

  if (MALE.has(normalized) || MALE.has(first)) return 'male';
  if (FEMALE.has(normalized) || FEMALE.has(first)) return 'female';

  // Arabic script heuristics (very rough)
  if (/ة$|ى$|اء$/.test(first)) return 'female';

  return 'unknown';
}

export function resolveGender(customerGender, fullName) {
  if (customerGender === 'male' || customerGender === 'female') return customerGender;
  return inferGenderFromName(fullName);
}

export default { inferGenderFromName, resolveGender };
