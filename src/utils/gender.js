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
    'abdallah', 'abdullah', 'abdelrahman', 'abdelrahman', 'abdel', 'hamza', 'yassin', 'yassine',
    'moaz', 'moaaz', 'mayar', // mayar can be either; leave out of female too if ambiguous
  ].filter((n) => n !== 'mayar')
);

const FEMALE = new Set([
  'sara', 'sarah', 'salma', 'nada', 'nour', 'noor', 'mona', 'maha', 'mai', 'may', 'mariam',
  'maryam', 'mariem', 'miriam', 'fatma', 'fatima', 'aya', 'ayaat', 'huda', 'hoda', 'heba',
  'hiba', 'rana', 'rania', 'dina', 'diana', 'layla', 'leila', 'laila', 'yasmin', 'yasmeen',
  'yasmine', 'farah', 'jana', 'janae', 'malak', 'menna', 'mena', 'nermin', 'nermine',
  'shereen', 'sherine', 'reem', 'rim', 'rima', 'omnia', 'omneya', 'esraa', 'israa', 'isra',
  'nancy', 'nelly', 'noura', 'nora', 'emily', 'emma', 'olivia', 'sophia', 'isabella', 'mia',
  'amira', 'ameera', 'basma', 'basmah', 'doaa', 'doa', 'ghada', 'ghada', 'hala', 'hanan',
  'iman', 'eman', 'lina', 'lena', 'nadine', 'nadeen', 'samar', 'samira', 'zeinab', 'zainab',
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
