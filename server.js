// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const cors = require('cors');
const {
  API: YooMoneyAPI,
  YMPaymentFormBuilder,
  YMNotificationChecker,
  YMNotificationError
} = require('./lib/yoomoney-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = '123456';
const ADMIN_PASSWORD = '123456';
const MAX_CRASH_HISTORY = 5;
const MAX_ROULETTE_HISTORY = 10;
const MAX_COINFLIP_HISTORY = 20;
const MAX_DICE_HISTORY = 20;
const MAX_PLINKO_HISTORY = 30;
const MAX_DEPOSITS_FILE_RECORDS = 1000;
const MAX_DEPOSIT_HISTORY = 20;
const DEPOSIT_COOLDOWN_MS = 60 * 60 * 1000; // 1 час между пополнениями

const PLINKO_ROWS = [8, 9, 10, 11, 12, 13, 14, 15, 16];
const PLINKO_RISKS = ['low', 'medium', 'high'];
// RTP чуть меньше 1.0, чтобы казино было в плюсе
const PLINKO_RTP = { low: 0.97, medium: 0.96, high: 0.95 };
// Диапазоны множителей: low: 0.8-10x, medium: 0.5-80x, high: 0.2-1000x
const PLINKO_MIN_MULT = { low: 0.8, medium: 0.5, high: 0.2 };
const PLINKO_MAX_MULT = { low: 10, medium: 80, high: 1000 };
const plinkoMultipliersCache = new Map();

// Конфигурация комиссий казино
const gameConfigFile = path.join(__dirname, 'data', 'game-config.json');

function readGameConfig() {
  try {
    if (!fs.existsSync(gameConfigFile)) {
      const defaultConfig = {
        coinflipMultiplier: 1.95,
        diceCommissionPercent: 2,
        rouletteCommissionPercent: 3,
        crashCommissionPercent: 2
      };
      writeGameConfig(defaultConfig);
      return defaultConfig;
    }
    const data = fs.readFileSync(gameConfigFile, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Ошибка чтения game-config.json:', err);
    return {
      coinflipMultiplier: 1.95,
      diceCommissionPercent: 2,
      rouletteCommissionPercent: 3,
      crashCommissionPercent: 2
    };
  }
}

function writeGameConfig(config) {
  try {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(gameConfigFile, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Ошибка записи game-config.json:', err);
  }
}

let gameConfig = readGameConfig();

// --------------- CORS ---------------
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' ? 'https://infer.cfd',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Set-Cookie']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(
  session({
    secret: 'mySecretKey',
    resave: false,
    saveUninitialized: true,
    cookie: { 
      secure: process.env.NODE_ENV === 'production', // true только в production
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 часа
    }
  })
);
// Запрещаем прямой доступ к JSON файлам
app.use((req, res, next) => {
  if (req.path.endsWith('.json') && !req.path.startsWith('/admin/download/')) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
});
app.use(express.static(path.join(__dirname)));

const usersFile = path.join(__dirname, 'data', 'users.json');
const historyFile = path.join(__dirname, 'data', 'history.json');
const depositsFile
 = path.join(__dirname, 'data', 'deposits.json');
const promocodesFile = path.join(__dirname, 'data', 'promocodes.json');
const promocodeUsageFile = path.join(__dirname, 'data', 'promocode-usage.json');
const yoomoneyPaymentsFile = path.join(__dirname, 'data', 'yoomoney-payments.json');
const withdrawalsFile = path.join(__dirname, 'data', 'withdrawals.json');

// YooMoney конфигурация
const YOOMONEY_RECEIVER = process.env.YOOMONEY_RECEIVER || '79375809887'; // Номер кошелька получателя
const YOOMONEY_NOTIFICATION_SECRET =
  process.env.YOOMONEY_NOTIFICATION_SECRET || 'efXxjdKBau2tSeN6tiNOq9Yy';
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 
  (process.env.NODE_ENV === 'production' ? 'https://infer.cfd' : 'http://localhost:' + PORT);
  const YOOMONEY_ACCESS_TOKEN = process.env.YOOMONEY_ACCESS_TOKEN || '4DE7164E17CF3B03665854D098FF869341D04A144FBA46B5047F0B7EE86DBC09';
const YOOMONEY_PAYMENT_TYPE = (process.env.YOOMONEY_PAYMENT_TYPE || 'AC').toUpperCase();
if (!YOOMONEY_RECEIVER || !YOOMONEY_NOTIFICATION_SECRET) {
  console.warn('⚠️ YooMoney env vars are missing. Check receiver and notification secret.');
}
const PAYMENT_TTL_MINUTES = Number(process.env.YOOMONEY_PAYMENT_TTL_MINUTES || 30);
const YOOMONEY_PAYMENT_TTL_MS =
  Number.isFinite(PAYMENT_TTL_MINUTES) && PAYMENT_TTL_MINUTES > 0
    ? PAYMENT_TTL_MINUTES * 60 * 1000
    : 30 * 60 * 1000;
const yoomoneyApiClient = YOOMONEY_ACCESS_TOKEN ? new YooMoneyAPI(YOOMONEY_ACCESS_TOKEN) : null;
const YOOMONEY_AMOUNT_TOLERANCE = Number(process.env.YOOMONEY_AMOUNT_TOLERANCE || 0.1);
const YOOMONEY_COMMISSION_RULES = {
  AC: { mode: 'from_sum', rate: 0.03 }, // комиссия удерживается из суммы списания
  PC: { mode: 'from_amount_due', rate: 0.01 } // комиссия удерживается из суммы к получению
};
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN || 10);
const WITHDRAW_MAX = Number(process.env.WITHDRAW_MAX || 50000);
const WITHDRAW_FEE_PERCENT = Number(process.env.WITHDRAW_FEE_PERCENT || 0);
const notificationChecker = new YMNotificationChecker(YOOMONEY_NOTIFICATION_SECRET);
const YOOMONEY_SBP_PATTERN_ID = process.env.YOOMONEY_SBP_PATTERN_ID || '97186';
const ensureUsersFileExists = () => {
  const dir = path.join(__dirname, 'data'); 
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]', 'utf-8');
};
ensureUsersFileExists();

const ensureHistoryFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(historyFile)) {
    const initial = {
      crashHistory: [],
      rouletteHistory: [],
      coinflipHistory: [],
      diceHistory: [],
      plinkoHistory: []
    };
    fs.writeFileSync(historyFile, JSON.stringify(initial, null, 2));
  }
};
ensureHistoryFileExists();

const ensureDepositsFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(depositsFile)) {
    fs.writeFileSync(depositsFile, '[]', 'utf-8');
  }
};
ensureDepositsFileExists();

const ensurePromocodesFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(promocodesFile)) {
    fs.writeFileSync(promocodesFile, '[]', 'utf-8');
  }
  if (!fs.existsSync(promocodeUsageFile)) {
    fs.writeFileSync(promocodeUsageFile, '{}', 'utf-8');
  }
};
ensurePromocodesFileExists();

const ensureYooMoneyPaymentsFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(yoomoneyPaymentsFile)) {
    fs.writeFileSync(yoomoneyPaymentsFile, '[]', { encoding: 'utf8' });
  } else {
    // Проверяем и исправляем файл, если он поврежден
    try {
      let data = fs.readFileSync(yoomoneyPaymentsFile, 'utf-8');
      // Удаляем BOM если есть
      if (data.charCodeAt(0) === 0xFEFF) {
        data = data.slice(1);
        fs.writeFileSync(yoomoneyPaymentsFile, data, { encoding: 'utf8' });
      }
      // Проверяем валидность JSON
      JSON.parse(data.trim() || '[]');
    } catch (err) {
      // Если файл поврежден, пересоздаем
      console.log('Файл yoomoney-payments.json поврежден, пересоздаем...');
      fs.writeFileSync(yoomoneyPaymentsFile, '[]', { encoding: 'utf8' });
    }
  }
};
ensureYooMoneyPaymentsFileExists();

const ensureWithdrawalsFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(withdrawalsFile)) {
    fs.writeFileSync(withdrawalsFile, '[]', { encoding: 'utf8' });
  }
};
ensureWithdrawalsFileExists();

function readPromocodes() {
  try {
    const data = fs.readFileSync(promocodesFile, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Ошибка чтения promocodes.json:', err);
    return [];
  }
}

function writePromocodes(arr) {
  fs.writeFileSync(promocodesFile, JSON.stringify(arr, null, 2));
}

function readPromocodeUsage() {
  try {
    const data = fs.readFileSync(promocodeUsageFile, 'utf-8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Ошибка чтения promocode-usage.json:', err);
    return {};
  }
}

function writePromocodeUsage(obj) {
  fs.writeFileSync(promocodeUsageFile, JSON.stringify(obj, null, 2));
}

function readDeposits() {
  try {
    const data = fs.readFileSync(depositsFile, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Ошибка чтения deposits.json:', err);
    return [];
  }
}

function writeDeposits(arr) {
  fs.writeFileSync(depositsFile, JSON.stringify(arr, null, 2));
}

function readYooMoneyPayments() {
  try {
    if (!fs.existsSync(yoomoneyPaymentsFile)) {
      ensureYooMoneyPaymentsFileExists();
      return [];
    }
    let data = fs.readFileSync(yoomoneyPaymentsFile, 'utf-8');
    // Удаляем BOM (Byte Order Mark) если есть
    if (data.charCodeAt(0) === 0xFEFF) {
      data = data.slice(1);
    }
    // Удаляем все невидимые символы в начале
    data = data.trim();
    // Если файл пустой или содержит только пробелы, возвращаем пустой массив
    if (!data || data === '') {
      return [];
    }
    return JSON.parse(data);
  } catch (err) {
    console.error('Ошибка чтения yoomoney-payments.json:', err);
    // Если файл поврежден, создаем новый
    try {
      fs.writeFileSync(yoomoneyPaymentsFile, '[]', { encoding: 'utf8' });
      console.log('Файл yoomoney-payments.json пересоздан');
    } catch (writeErr) {
      console.error('Ошибка пересоздания файла:', writeErr);
    }
    return [];
  }
}

function writeYooMoneyPayments(arr) {
  try {
    const jsonString = JSON.stringify(arr, null, 2);
    // Записываем в UTF-8 без BOM
    fs.writeFileSync(yoomoneyPaymentsFile, jsonString, { encoding: 'utf8' });
  } catch (err) {
    console.error('Ошибка записи yoomoney-payments.json:', err);
    throw err;
  }
}

function readWithdrawals() {
  try {
    const data = fs.readFileSync(withdrawalsFile, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Ошибка чтения withdrawals.json:', err);
    return [];
  }
}

function writeWithdrawals(arr) {
  fs.writeFileSync(withdrawalsFile, JSON.stringify(arr, null, 2));
}

function normalizeAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  // Округляем до сотых (2 знака после запятой)
  return Math.round(num * 100) / 100;
}

function roundToCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  // Округляем до сотых
  return Math.round(num * 100) / 100;
}

function formatCoinsForClient(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('de-DE');
}

function combination(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

function getPlinkoKey(risk, rows) {
  return `${risk}_${rows}`;
}

function ensurePlinkoMultipliers(risk, rows) {
  const safeRisk = PLINKO_RISKS.includes(risk) ? risk : 'medium';
  const key = getPlinkoKey(safeRisk, rows);
  if (plinkoMultipliersCache.has(key)) {
    return plinkoMultipliersCache.get(key);
  }
  const buckets = rows + 1;
  const center = rows / 2;
  const minMult = PLINKO_MIN_MULT[safeRisk] || PLINKO_MIN_MULT.medium;
  const maxMult = PLINKO_MAX_MULT[safeRisk] || PLINKO_MAX_MULT.medium;
  
  // Создаем множители от минимума в центре до максимума на краях
  const multipliers = [];
  for (let i = 0; i < buckets; i++) {
    const distance = Math.abs(i - center);
    const normalized = center === 0 ? 0 : distance / center; // 0 в центре, 1 на краях
    
    // Используем экспоненциальную функцию для плавного перехода
    // Чем дальше от центра, тем выше множитель
    // Для высокого риска более резкий переход к максимуму
    const power = safeRisk === 'high' ? 2.5 : safeRisk === 'medium' ? 2.0 : 1.5;
    const ratio = Math.pow(normalized, power);
    
    // Интерполируем от минимума к максимуму
    let multiplier = minMult + (maxMult - minMult) * ratio;
    
    // Для крайних позиций устанавливаем максимум
    if (i === 0 || i === buckets - 1) {
      multiplier = maxMult;
    }
    // Для центра устанавливаем минимум
    if (i === Math.floor(center) || (center % 1 !== 0 && (i === Math.floor(center) || i === Math.ceil(center)))) {
      multiplier = minMult;
    }
    
    multipliers.push(Number(multiplier.toFixed(2)));
  }

  // Проверяем RTP и корректируем если нужно
  const probabilities = [];
  const denominator = Math.pow(2, rows);
  for (let i = 0; i < buckets; i++) {
    probabilities[i] = combination(rows, i) / denominator;
  }
  const expectedValue = multipliers.reduce((sum, val, idx) => sum + val * probabilities[idx], 0);
  const targetRtp = PLINKO_RTP[safeRisk] || PLINKO_RTP.medium;
  const scale = expectedValue > 0 ? targetRtp / expectedValue : 1;
  
  // Применяем масштабирование, сохраняя диапазон
  const scaled = multipliers.map((val, idx) => {
    // Края всегда максимальные, центр всегда минимальный
    if (idx === 0 || idx === buckets - 1) {
      return maxMult;
    }
    if (idx === Math.floor(center) || (center % 1 !== 0 && idx === Math.ceil(center))) {
      return minMult;
    }
    
    // Для остальных применяем масштабирование
    const scaledVal = val * scale;
    // Ограничиваем значения диапазоном
    const clamped = Math.max(minMult, Math.min(maxMult, scaledVal));
    return Number(clamped.toFixed(2));
  });
  
  plinkoMultipliersCache.set(key, scaled);
  return scaled;
}

function buildPlinkoConfig() {
  const multipliers = {};
  PLINKO_RISKS.forEach((risk) => {
    multipliers[risk] = {};
    PLINKO_ROWS.forEach((rows) => {
      multipliers[risk][rows] = ensurePlinkoMultipliers(risk, rows);
    });
  });
  return {
    risks: PLINKO_RISKS,
    rows: PLINKO_ROWS,
    multipliers
  };
}

function normalizeTextToken(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function amountsClose(expected, actual, tolerance = YOOMONEY_AMOUNT_TOLERANCE) {
  if (expected === null || actual === null) {
    return false;
  }
  return Math.abs(expected - actual) <= tolerance;
}

function getCommissionRule(paymentType = YOOMONEY_PAYMENT_TYPE) {
  return YOOMONEY_COMMISSION_RULES[paymentType] || YOOMONEY_COMMISSION_RULES.AC;
}

function calculatePayableAmount(targetAmount, paymentType = YOOMONEY_PAYMENT_TYPE) {
  const rule = getCommissionRule(paymentType);
  let payable = targetAmount;
  if (rule.mode === 'from_sum') {
    payable = targetAmount / (1 - rule.rate);
  } else if (rule.mode === 'from_amount_due') {
    payable = targetAmount * (1 + rule.rate);
  }
  return normalizeAmount(payable);
}

function calculateWithdrawNet(amount) {
  if (!WITHDRAW_FEE_PERCENT) return amount;
  const fee = (amount * WITHDRAW_FEE_PERCENT) / 100;
  return normalizeAmount(Math.max(amount - fee, 0));
}

function generatePaymentId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ym_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildPaymentLabel(username, paymentId) {
  return `fen4:${username}:${paymentId}`;
}

function findPaymentById(payments, paymentId) {
  return payments.find((p) => p.paymentId === paymentId);
}

function findPaymentByLabel(payments, label) {
  return payments.find((p) => p.label === label);
}

function generateWithdrawalId() {
  return `wd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractOperationAmount(operation) {
  if (!operation || typeof operation !== 'object') {
    return null;
  }
  const candidates = [operation.amount, operation.amount_due, operation.withdraw_amount];
  for (const candidate of candidates) {
    const normalized = normalizeAmount(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function operationContainsPaymentTag(operation, payment) {
  if (!operation || !payment) return false;
  const tagCandidates = [
    payment.paymentId,
    payment.label,
    normalizeTextToken(payment.operationId)
  ].filter(Boolean);
  if (!tagCandidates.length) {
    return false;
  }
  const fields = [
    operation.label,
    operation.comment,
    operation.message,
    operation.details,
    operation.title
  ];
  return tagCandidates.some((tag) =>
    fields.some((field) => typeof field === 'string' && field.includes(tag))
  );
}

function operationMatchesPayment(operation, payment) {
  const paidAmount = extractOperationAmount(operation);
  if (paidAmount === null) {
    return false;
  }
  const expectedPaid = payment.payableAmount ?? payment.amount;
  if (!amountsClose(expectedPaid, paidAmount)) {
    return false;
  }
  const labelMatch =
    payment.label &&
    typeof operation.label === 'string' &&
    normalizeTextToken(operation.label) === normalizeTextToken(payment.label);
  return labelMatch || operationContainsPaymentTag(operation, payment);
}

function applyDepositFromPayment(payment, amount, operationId) {
  const user = findUser(payment.username);
  if (!user) {
    console.warn(`YooMoney: пользователь ${payment.username} не найден для платежа ${payment.paymentId}`);
    return null;
  }
  const newBalance = user.balance + amount*1000000;
  updateUserBalance(payment.username, newBalance);

  const deposits = readDeposits();
  deposits.push({
    username: payment.username,
    amount,
    timestamp: Date.now(),
    method: 'yoomoney',
    paymentId: payment.paymentId,
    operationId
  });
  if (deposits.length > MAX_DEPOSITS_FILE_RECORDS) {
    deposits.splice(0, deposits.length - MAX_DEPOSITS_FILE_RECORDS);
  }
  writeDeposits(deposits);
  return newBalance;
}

function finalizeYooMoneyPayment(payment, payments, details = {}) {
  const paidAmount = normalizeAmount(details.paidAmount ?? payment.payableAmount ?? payment.amount);
  if (paidAmount === null) {
    throw new Error('YooMoney: некорректная сумма платежа');
  }
  const expectedCredit = payment.expectedCredit ?? payment.amount;
  const creditedAmountRaw = normalizeAmount(details.creditAmount ?? expectedCredit);
  if (creditedAmountRaw === null) {
    throw new Error('YooMoney: некорректная сумма зачисления');
  }

  payment.status = 'success';
  payment.paidAmount = paidAmount;
  payment.operationId = details.operationId || payment.operationId || null;
  payment.confirmationSource = details.source || 'webhook';
  payment.confirmedAt = Date.now();
  payment.creditedAmount = creditedAmountRaw;
  if (details.payload) {
    payment.lastPayload = details.payload;
  }
  applyDepositFromPayment(payment, creditedAmountRaw, payment.operationId);
  writeYooMoneyPayments(payments);
  return paidAmount;
}

async function trySyncPaymentWithAPI(payment, payments) {
  if (!yoomoneyApiClient || payment.status !== 'pending') {
    return false;
  }
  const queries = [
    { label: payment.label, records: 20 },
    { type: 'deposition', records: 50 },
    { records: 200 }
  ];
  try {
    for (const params of queries) {
      let history;
      try {
        history = await yoomoneyApiClient.operationHistory(params);
      } catch (err) {
        console.warn('YooMoney operationHistory query failed:', params, err.message || err);
        continue;
      }
      const operations = Array.isArray(history.operations) ? history.operations : [];
      const match = operations.find((op) => {
        if (!op) return false;
        const directionOk = op.direction ? String(op.direction).toLowerCase() === 'in' : true;
        const statusOk = op.status ? String(op.status).toLowerCase() === 'success' : true;
        return directionOk && statusOk && operationMatchesPayment(op, payment);
      });
      if (!match) {
        continue;
      }
      const paidAmount = extractOperationAmount(match);
      if (paidAmount === null) {
        continue;
      }
      finalizeYooMoneyPayment(payment, payments, {
        paidAmount,
      creditAmount: payment.expectedCredit ?? payment.amount,
        operationId: match.operation_id || match.operationId || `api_${Date.now()}`,
        source: 'api_history',
        payload: match
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error('YooMoney API sync failed:', err.message || err);
    return false;
  }
}

function getUserDepositsMeta(username) {
  const allDeposits = readDeposits();
  const userDeposits = allDeposits
    .filter((entry) => entry.username === username)
    .sort((a, b) => b.timestamp - a.timestamp);
  const nextDepositAt = userDeposits.length
    ? userDeposits[0].timestamp + DEPOSIT_COOLDOWN_MS
    : null;
  return {
    allDeposits,
    userDeposits: userDeposits.slice(0, MAX_DEPOSIT_HISTORY),
    nextDepositAt
  };
}

function readHistoryStore() {
  try {
    const raw = fs.readFileSync(historyFile, 'utf-8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Ошибка чтения history.json:', err);
    return { crashHistory: [], rouletteHistory: [] };
  }
}

function writeHistoryStore(store) {
  fs.writeFileSync(historyFile, JSON.stringify(store, null, 2));
}

function collectUserGameHistory(username) {
  const crash = crashHistory.filter(
    (round) => Array.isArray(round.players) && round.players.some((p) => p.username === username)
  );
  const roulette = rouletteHistory.filter(
    (round) => Array.isArray(round.players) && round.players.some((p) => p.username === username)
  );
  const coinflip = coinflipHistory.filter((entry) => entry.username === username);
  const dice = diceHistory.filter((entry) => entry.username === username);
  const plinko = plinkoHistory.filter((entry) => entry.username === username);
  return { crash, roulette, coinflip, dice, plinko };
}

function readUsers() {
  const data = fs.readFileSync(usersFile, 'utf-8');
  return JSON.parse(data || '[]');
}
function writeUsers(arr) {
  fs.writeFileSync(usersFile, JSON.stringify(arr, null, 2), 'utf-8');
}
function findUser(username) {
  const users = readUsers();
  return users.find((u) => u.username === username);
}
function updateUserBalance(username, newBalance) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx !== -1) {
    // Округляем баланс до сотых
    users[idx].balance = roundToCents(newBalance);
    writeUsers(users);
    return true;
  }
  return false;
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Нет доступа' });
  }
  next();
}

// ======= регистрация / login / check-auth / logout =======
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const all = readUsers();

    // Проверяем, не занят ли username
    if (all.find((u) => u.username === username)) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    // Клиент уже передаёт SHA-256‐хэш
    const passwordHash = password;

    all.push({ username, passwordHash, balance: 1000, ip: userIP, banned: false });
    writeUsers(all);

    res.json({ message: 'Регистрация успешна!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  try {
    const user = findUser(username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Проверяем блокировку
    if (user.banned === true) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Напишите в лс @zooond' });
    }

    // Сравниваем хэши паролей
    if (user.passwordHash !== password) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    // Устанавливаем сессию
    req.session.user = { username: user.username };
    res.json({
      message: 'Аутентификация успешна',
      user: { username: user.username, balance: user.balance }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при логине' });
  }
});

app.get('/check-auth', (req, res) => {
  // 1) Если сессия уже есть — возвращаем данные пользователя
  if (req.session.user) {
    try {
      const user = findUser(req.session.user.username);
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      if (user.banned === true) {
        return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Напишите в лс @zooond' });
      }
      return res.json({ username: user.username, balance: user.balance });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Ошибка сервера при проверке авторизации' });
    }
  }

  // 2) Если сессии нет — пробуем «авто-логин» по IP
  const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const all = readUsers();
  const user = all.find((u) => u.ip === userIP);

  if (user) {
    if (user.banned === true) {
      return res.status(403).json({ error: 'Ваш аккаунт заблокирован. Напишите в лс @zooond' });
    }
    req.session.user = { username: user.username };
    return res.json({ username: user.username, balance: user.balance });
  }

  // 3) Если ни сессии, ни IP совпадения — не авторизован
  return res.status(401).json({ error: 'Не авторизован' });
});

app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Ошибка при выходе' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Выход выполнен' });
  });
});
// ======= конец auth =======

// ======= админ-панель =======
app.post('/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ message: 'Администратор авторизован' });
  }
  return res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.post('/admin/logout', (req, res) => {
  req.session.admin = false;
  res.json({ message: 'Админ вышел' });
});

app.get('/admin/session', (req, res) => {
  if (req.session.admin) {
    return res.json({ authorized: true });
  }
  return res.status(401).json({ authorized: false });
});

app.get('/admin/users', requireAdmin, (req, res) => {
  const users = readUsers().map(({ username, balance, banned }) => ({ 
    username, 
    balance, 
    banned: banned === true 
  }));
  res.json(users);
});

app.patch('/admin/users/:username', requireAdmin, (req, res) => {
  const { username } = req.params;
  const { balance } = req.body;
  if (typeof balance !== 'number' || balance < 0) {
    return res.status(400).json({ error: 'Некорректный баланс' });
  }
  const users = readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx === -1) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  users[idx].balance = balance;
  writeUsers(users);
  res.json({ username: users[idx].username, balance: users[idx].balance });
});

app.post('/admin/users/:username/ban', requireAdmin, (req, res) => {
  const { username } = req.params;
  const users = readUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx === -1) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  users[idx].banned = !users[idx].banned;
  writeUsers(users);
  res.json({ username: users[idx].username, banned: users[idx].banned });
});

app.get('/admin/download/users.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="users.json"');
  res.sendFile(usersFile);
});

app.get('/admin/download/history.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="history.json"');
  res.sendFile(historyFile);
});

app.get('/admin/download/deposits.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="deposits.json"');
  res.sendFile(depositsFile);
});

app.get('/admin/yoomoney/test', requireAdmin, async (req, res) => {
  if (!yoomoneyApiClient) {
    return res.status(400).json({ error: 'YooMoney API client not initialized' });
  }
  try {
    const accountInfo = await yoomoneyApiClient.accountInfo();
    res.json({ success: true, accountInfo });
  } catch (err) {
    console.error('YooMoney API test failed:', err);
    res.status(500).json({ error: 'API test failed', details: err.message || String(err) });
  }
});

app.get('/admin/users/:username/profile', requireAdmin, (req, res) => {
  const { username } = req.params;
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  const deposits = readDeposits().filter((d) => d.username === username);
  const yoomoneyPayments = readYooMoneyPayments().filter((p) => p.username === username);
  const withdrawals = readWithdrawals().filter((w) => w.username === username);
  const games = collectUserGameHistory(username);
  const promocodeUsage = readPromocodeUsage();
  // Получаем список промокодов, использованных пользователем
  const userPromocodes = [];
  Object.keys(promocodeUsage).forEach((key) => {
    if (key.endsWith('_timestamps')) {
      const code = key.replace('_timestamps', '');
      const timestamps = promocodeUsage[key];
      if (timestamps && typeof timestamps === 'object' && timestamps[username]) {
        userPromocodes.push({ code, activatedAt: timestamps[username] });
      }
    } else if (Array.isArray(promocodeUsage[key]) && promocodeUsage[key].includes(username)) {
      // Если есть массив пользователей, но нет временных меток
      const code = key;
      const timestampKey = code + '_timestamps';
      const activatedAt = promocodeUsage[timestampKey]?.[username] || null;
      if (!userPromocodes.find(p => p.code === code)) {
        userPromocodes.push({ code, activatedAt });
      }
    }
  });
  res.json({
    user: {
      username: user.username,
      balance: user.balance,
      banned: user.banned === true,
      ip: user.ip
    },
    deposits,
    yoomoneyPayments,
    withdrawals,
    games,
    promocodes: userPromocodes
  });
});

app.get('/admin/withdrawals', requireAdmin, (req, res) => {
  res.json(readWithdrawals());
});

function updateWithdrawalRecord(targetId, mutator) {
  const withdrawals = readWithdrawals();
  const index = withdrawals.findIndex((w) => w.id === targetId);
  if (index === -1) {
    return null;
  }
  const updated = mutator({ ...withdrawals[index] });
  updated.updatedAt = Date.now();
  withdrawals[index] = updated;
  writeWithdrawals(withdrawals);
  return updated;
}

async function performSbpPayout(withdrawal) {
  if (!yoomoneyApiClient || !YOOMONEY_SBP_PATTERN_ID) {
    throw new Error('YooMoney SBP payouts не настроены');
  }
  const requestParams = {
    pattern_id: YOOMONEY_SBP_PATTERN_ID,
    amount: withdrawal.amount,
    'bank-name': withdrawal.bankName,
    'sbp-bank-id': withdrawal.sbpBankId || '',
    'phone-number': withdrawal.phone,
    comment: withdrawal.comment || `SBP вывод ${withdrawal.id}`
  };
  const request = await yoomoneyApiClient.requestPayment(requestParams);
  if (request.status !== 'success') {
    throw new Error(`request-payment: ${request.error || request.status}`);
  }
  const processResponse = await yoomoneyApiClient.processPayment({
    request_id: request.request_id,
    money_source: 'wallet'
  });
  if (processResponse.status !== 'success') {
    throw new Error(`process-payment: ${processResponse.error || processResponse.status}`);
  }
  return { request, processResponse };
}

app.post('/admin/withdrawals/:withdrawalId/process', requireAdmin, async (req, res) => {
  const { withdrawalId } = req.params;
  let payoutResult = null;
  try {
    const updated = await (async () =>
      updateWithdrawalRecord(withdrawalId, (withdrawal) => {
        if (!withdrawal || withdrawal.status !== 'pending') {
          throw new Error('Выплата уже обработана или не найдена');
        }
        return { ...withdrawal, status: 'processing', processingAt: Date.now() };
      }))();
    if (!updated) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }
    payoutResult = await performSbpPayout(updated);
    const finalRecord = updateWithdrawalRecord(withdrawalId, (withdrawal) => ({
      ...withdrawal,
      status: 'completed',
      completedAt: Date.now(),
      payoutMeta: payoutResult
    }));
    res.json(finalRecord);
  } catch (err) {
    console.error('Ошибка выплаты через SBP:', err);
    updateWithdrawalRecord(withdrawalId, (withdrawal) => ({
      ...withdrawal,
      status: 'error',
      error: err.message,
      errorAt: Date.now()
    }));
    res.status(500).json({ error: err.message || 'Ошибка выплаты' });
  }
});

app.post('/admin/withdrawals/:withdrawalId/cancel', requireAdmin, (req, res) => {
  const { withdrawalId } = req.params;
  let targetUser = null;
  const updated = updateWithdrawalRecord(withdrawalId, (withdrawal) => {
    if (!withdrawal || withdrawal.status !== 'pending') {
      throw new Error('Заявка уже обработана');
    }
    targetUser = findUser(withdrawal.username);
    if (targetUser) {
      updateUserBalance(withdrawal.username, targetUser.balance + withdrawal.amount);
    }
    return { ...withdrawal, status: 'cancelled', cancelledAt: Date.now() };
  });
  if (!updated) {
    return res.status(404).json({ error: 'Заявка не найдена' });
  }
  res.json(updated);
});
// ======= конец админки =======

// ======= профиль пользователя =======
app.get('/profile/deposit-status', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const { nextDepositAt } = getUserDepositsMeta(req.session.user.username);
  const cooldownActive = nextDepositAt && nextDepositAt > Date.now() ? nextDepositAt : null;
  res.json({ nextDepositAt: cooldownActive });
});

app.post('/profile/deposit', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
    return res.status(400).json({ error: 'Сумма должна быть от 1 до 1000' });
  }

  const username = req.session.user.username;
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }

  const { allDeposits, nextDepositAt } = getUserDepositsMeta(username);
  const now = Date.now();
  if (nextDepositAt && nextDepositAt > now) {
    return res.status(429).json({
      error: 'Пополнение доступно раз в час',
      nextDepositAt
    });
  }

  const updatedBalance = user.balance + amount;
  updateUserBalance(username, updatedBalance);

  const depositEntry = { username, amount, timestamp: now };
  const updatedDeposits = [...allDeposits, depositEntry];
  if (updatedDeposits.length > MAX_DEPOSITS_FILE_RECORDS) {
    updatedDeposits.splice(0, updatedDeposits.length - MAX_DEPOSITS_FILE_RECORDS);
  }
  writeDeposits(updatedDeposits);

  const metaAfterSave = getUserDepositsMeta(username);

  res.json({
    message: `Баланс пополнен на ${amount}`,
    newBalance: updatedBalance,
    nextDepositAt: metaAfterSave.nextDepositAt,
    deposits: metaAfterSave.userDeposits
  });
});

// ======= YooMoney пополнение =======
app.post('/profile/yoomoney/create', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const amount = normalizeAmount(req.body.amount);
  if (amount === null || amount < 1 || amount > 50000) {
    return res.status(400).json({ error: 'Сумма должна быть от 1 до 50000 рублей' });
  }

  const username = req.session.user.username;
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }

  try {
    const paymentId = generatePaymentId();
    const label = buildPaymentLabel(username, paymentId);
    const createdAt = Date.now();
    const expiresAt = createdAt + YOOMONEY_PAYMENT_TTL_MS;
    const payableAmount = calculatePayableAmount(amount, YOOMONEY_PAYMENT_TYPE);
    const commissionRule = getCommissionRule(YOOMONEY_PAYMENT_TYPE);

    const payments = readYooMoneyPayments();
    payments.push({
      paymentId,
      username,
      amount,
      expectedCredit: amount,
      payableAmount,
      paymentType: YOOMONEY_PAYMENT_TYPE,
      commissionRate: commissionRule.rate,
      label,
      status: 'pending',
      createdAt,
      expiresAt,
      currency: 'RUB'
    });
    writeYooMoneyPayments(payments);

    res.json({
      paymentId,
      paymentUrl: `${PUBLIC_BASE_URL}/profile/yoomoney/pay/${paymentId}`,
      expiresAt,
      payableAmount,
      paymentType: YOOMONEY_PAYMENT_TYPE,
      amount
    });
  } catch (error) {
    console.error('Ошибка создания платежа YooMoney:', error);
    res.status(500).json({ error: 'Ошибка создания платежа: ' + error.message });
  }
});

// Страница оплаты YooMoney (формируется через yoomoney-sdk)
app.get('/profile/yoomoney/pay/:paymentId', (req, res) => {
  const { paymentId } = req.params;
  const payments = readYooMoneyPayments();
  const payment = findPaymentById(payments, paymentId);

  if (!payment) {
    return res.status(404).send('Платеж не найден');
  }

  const paymentTag = `#${payment.paymentId}`;

  if (payment.status !== 'pending') {
    return res.status(400).send('Платеж уже обработан');
  }

  if (payment.expiresAt && payment.expiresAt < Date.now()) {
    payment.status = 'expired';
    payment.expiredAt = Date.now();
    writeYooMoneyPayments(payments);
    return res.status(410).send('Срок действия платежа истёк');
  }

  const builder = new YMPaymentFormBuilder({
    receiver: YOOMONEY_RECEIVER,
    sum: Number(payment.payableAmount ?? payment.amount).toFixed(2),
    label: payment.label,
    successURL: `${PUBLIC_BASE_URL}/profile.html?payment=${payment.paymentId}`,
    targets: `Пополнение баланса ${payment.username} ${paymentTag}`,
    comment: `Пополнение fen4yara ${paymentTag}`,
    quickpayForm: 'shop',
    paymentType: 'AC'
  });

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(builder.buildHtml(true));
});

// Webhook для обработки уведомлений от YooMoney
// YooMoney отправляет уведомления о входящих платежах
// Для quickpay формы нужно настроить webhook URL в настройках кошелька YooMoney
app.options('/profile/yoomoney/webhook', cors(corsOptions), (req, res) => {
  res.sendStatus(200);
});

app.post(
  '/profile/yoomoney/webhook',
  express.urlencoded({ extended: true }),
  notificationChecker.middleware({ memo: true }, (req, res) => {
    console.log('🔔 YooMoney webhook received:', {
      headers: req.headers,
      body: req.body
    });
    const { label, amount, operation_id } = req.body;
    const incomingLabel = String(label || '').trim();
    const payments = readYooMoneyPayments();
    const payment = findPaymentByLabel(payments, incomingLabel);

    if (!payment) {
      console.warn(`YooMoney webhook: платеж с label "${incomingLabel}" не найден`, req.body);
      return res.status(200).send('UNKNOWN_PAYMENT');
    }

    if (payment.status !== 'pending') {
      return res.status(200).send('ALREADY_PROCESSED');
    }

    if (payment.expiresAt && payment.expiresAt < Date.now()) {
      payment.status = 'expired';
      payment.expiredAt = Date.now();
      writeYooMoneyPayments(payments);
      return res.status(200).send('EXPIRED');
    }

    const paidAmount = normalizeAmount(amount);
    if (paidAmount === null) {
      return res.status(400).send('INVALID_AMOUNT');
    }

    const expectedPayable = payment.payableAmount ?? payment.amount;
    let creditAmount = payment.expectedCredit ?? payment.amount;
    if (!amountsClose(expectedPayable, paidAmount)) {
      console.warn(
        `YooMoney webhook: сумма ${paidAmount} отличается от ожидаемой ${expectedPayable} для ${payment.paymentId}`
      );
    }

    try {
      finalizeYooMoneyPayment(payment, payments, {
        paidAmount,
        creditAmount,
        operationId: operation_id || `operation_${Date.now()}`,
        source: 'webhook',
        payload: req.body
      });
      console.log(
        `✅ Платеж ${payment.paymentId} подтвержден через webhook на сумму ${paidAmount}`
      );
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Ошибка обработки платежа YooMoney:', err);
      return res.status(500).send('ERROR');
    }
  })
);

// Обработка ошибок уведомлений YooMoney
app.use((err, req, res, next) => {
  if (err instanceof YMNotificationError) {
    console.error('Ошибка верификации уведомления YooMoney:', err.message);
    return res.status(400).send('INVALID_NOTIFICATION');
  }
  return next(err);
});

// Проверка статуса платежа
app.get('/profile/yoomoney/check/:paymentId', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  const { paymentId } = req.params;
  const payments = readYooMoneyPayments();
  const payment = findPaymentById(payments, paymentId);

  if (!payment || payment.username !== req.session.user.username) {
    return res.status(404).json({ error: 'Платеж не найден' });
  }

  let shouldPersist = false;
  if (payment.status === 'pending') {
    if (payment.expiresAt && payment.expiresAt < Date.now()) {
      payment.status = 'expired';
      payment.expiredAt = Date.now();
      shouldPersist = true;
    } else {
      const synced = await trySyncPaymentWithAPI(payment, payments);
      if (synced) {
        // финализация уже сохранила данные
        shouldPersist = false;
      }
    }
  }

  if (shouldPersist && payment.status !== 'success') {
    writeYooMoneyPayments(payments);
  }

  const user = findUser(req.session.user.username);
  res.json({
    status: payment.status,
    amount: payment.amount,
    payableAmount: payment.payableAmount || payment.amount,
    paidAmount: payment.paidAmount || null,
    balance: user ? user.balance : 0,
    expiresAt: payment.expiresAt || null,
    confirmedAt: payment.confirmedAt || null
  });
});

app.get('/profile/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const userCrash = crashHistory.filter(
    (round) => Array.isArray(round.players) && round.players.some((p) => p.username === username)
  );
  const userRoulette = rouletteHistory.filter(
    (round) => Array.isArray(round.players) && round.players.some((p) => p.username === username)
  );
  const userCoinflip = coinflipHistory.filter((entry) => entry.username === username);
  const userDice = diceHistory.filter((entry) => entry.username === username);
  const userPlinko = plinkoHistory.filter((entry) => entry.username === username);
  const withdrawals = readWithdrawals().filter((w) => w.username === username);
  const { userDeposits } = getUserDepositsMeta(username);
  res.json({
    crash: userCrash,
    roulette: userRoulette,
    coinflip: userCoinflip,
    dice: userDice,
    plinko: userPlinko,
    deposits: userDeposits,
    withdrawals
  });
});
// ======= конец профиля =======

// ======= вывод средств через SBP =======
app.post('/profile/withdraw/sbp', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  const amount = normalizeAmount(req.body.amount);
  if (amount === null || amount < WITHDRAW_MIN || amount > WITHDRAW_MAX) {
    return res
      .status(400)
      .json({ error: `Сумма вывода должна быть от ${WITHDRAW_MIN} до ${WITHDRAW_MAX}` });
  }
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }
  const { bankName, sbpBankId, phone, comment } = req.body;
  if (!bankName || !phone) {
    return res.status(400).json({ error: 'Укажите банк и номер телефона для выплаты по СБП' });
  }
  const netAmount = calculateWithdrawNet(amount);
  const feeAmount = normalizeAmount(amount - netAmount);
  const updatedBalance = user.balance - amount;
  updateUserBalance(username, updatedBalance);
  const withdrawals = readWithdrawals();
  const withdrawal = {
    id: generateWithdrawalId(),
    username,
    amount,
    netAmount,
    feeAmount: feeAmount || 0,
    bankName,
    sbpBankId: sbpBankId || '',
    phone,
    comment: comment || '',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  withdrawals.push(withdrawal);
  writeWithdrawals(withdrawals);
  res.json({
    message: 'Заявка на вывод создана. Ожидайте подтверждения администратора.',
    withdrawal,
    balance: updatedBalance
  });
});

app.get('/profile/withdrawals', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const withdrawals = readWithdrawals().filter((w) => w.username === username);
  res.json(withdrawals);
});

let roulettePlayers = []; // текущая очередь: [{ username, bet, color }]
let lastSpinPlayers = null; // «снимок» очереди перед спином
let lastSpinResult = null; // { winner, totalBet, timestamp, players: lastSpinPlayers }
let rouletteHistory = [];
let crashHistory = [];
let lastCrashResult = null;
let coinflipHistory = [];
let diceHistory = [];
let plinkoHistory = [];

(() => {
  const store = readHistoryStore();
  let needsPersist = false;
  const rawRoulette = Array.isArray(store.rouletteHistory) ? store.rouletteHistory : [];
  const rawCrash = Array.isArray(store.crashHistory) ? store.crashHistory : [];
  const rawCoinflip = Array.isArray(store.coinflipHistory) ? store.coinflipHistory : [];
  const rawDice = Array.isArray(store.diceHistory) ? store.diceHistory : [];
  const rawPlinko = Array.isArray(store.plinkoHistory) ? store.plinkoHistory : [];
  rouletteHistory = rawRoulette.slice(0, MAX_ROULETTE_HISTORY);
  crashHistory = rawCrash.slice(0, MAX_CRASH_HISTORY);
  coinflipHistory = rawCoinflip.slice(0, MAX_COINFLIP_HISTORY);
  diceHistory = rawDice.slice(0, MAX_DICE_HISTORY);
  plinkoHistory = rawPlinko.slice(0, MAX_PLINKO_HISTORY);
  needsPersist =
    needsPersist ||
    rawRoulette.length !== rouletteHistory.length ||
    rawCrash.length !== crashHistory.length ||
    rawCoinflip.length !== coinflipHistory.length ||
    rawDice.length !== diceHistory.length ||
    rawPlinko.length !== plinkoHistory.length;
  if (rouletteHistory.length) {
    lastSpinResult = rouletteHistory[0];
  }
  if (crashHistory.length) {
    lastCrashResult = crashHistory[0];
  }
  if (needsPersist) {
    writeHistoryStore({ crashHistory, rouletteHistory, coinflipHistory, diceHistory, plinkoHistory });
  }
})();

function persistHistory() {
  writeHistoryStore({
    crashHistory,
    rouletteHistory,
    coinflipHistory,
    diceHistory,
    plinkoHistory
  });
}

const spinInterval = 20000; // 20 сек

let nextSpin = null; // временная метка (ms) следующего запланированного спина
let spinTimeoutId = null;

// Генератор случайного цвета
function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

/**
 * Запускает спин. Если игроков < 2 — очищает очередь без результата.
 * Иначе сохраняет snapshot → выбирает победителя → обновляет баланс → сохраняет результат.
 */
function runSpin() {
  const now = Date.now();

  if (roulettePlayers.length < 2) {
    roulettePlayers = [];
    lastSpinResult = null;
    lastSpinPlayers = null;
  } else {
    // ДЕЛАЕМ ЧИСТЫЙ SNAPSHOT ИГРОКОВ
    lastSpinPlayers = roulettePlayers.map((p) => ({
      username: p.username,
      bet: p.bet,
      color: p.color
    }));

    const totalBet = roulettePlayers.reduce((sum, p) => sum + p.bet, 0);
    const winningTicket = Math.random() * totalBet;

    let cumulative = 0;
    let winnerEntry = lastSpinPlayers[lastSpinPlayers.length - 1];
    for (let p of lastSpinPlayers) {
      cumulative += p.bet;
      if (winningTicket <= cumulative) {
        winnerEntry = p;
        break;
      }
    }

    const winUser = findUser(winnerEntry.username);
    if (winUser) {
      const commission = roundToCents(totalBet * (gameConfig.rouletteCommissionPercent / 100));
      const payout = roundToCents(totalBet - commission);
      updateUserBalance(winnerEntry.username, winUser.balance + payout);
    }

    const commission = totalBet * (gameConfig.rouletteCommissionPercent / 100);
    const payout = Math.floor(totalBet - commission);
    
    lastSpinResult = {
      winner: winnerEntry.username,
      totalBet: totalBet,
      payout: payout,
      commission: commission,
      timestamp: now,
      players: lastSpinPlayers,
      winningTicket  // <--- КЛЮЧЕВАЯ ВЕЩЬ ДЛЯ КЛИЕНТА
    };
    rouletteHistory.unshift(lastSpinResult);
    if (rouletteHistory.length > MAX_ROULETTE_HISTORY) rouletteHistory.pop();
    persistHistory();

    roulettePlayers = [];
  }

  nextSpin = null;
  spinTimeoutId = null;

  if (roulettePlayers.length >= 2) {
    nextSpin = Date.now() + spinInterval;
    spinTimeoutId = setTimeout(runSpin, spinInterval);
  }
}


// Первый спин стартует внутри /roulette/join при появлении второго игрока.

// ========== ЭНДПОЙНТЫ ==========

// 1) Получить текущих игроков + nextSpin + serverTime
app.get('/roulette/players', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json({
    players: roulettePlayers,
    nextSpin,
    serverTime: Date.now()
  });
});

// 2) Игрок присоединяется к спину
app.post('/roulette/join', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { bet } = req.body;
  if (!bet || typeof bet !== 'number' || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  updateUserBalance(username, user.balance - bet);

  const existing = roulettePlayers.find((p) => p.username === username);
  if (existing) {
    existing.bet += bet;
  } else {
    roulettePlayers.push({ username, bet, color: getRandomColor() });
  }

  if (roulettePlayers.length === 2 && nextSpin === null) {
    nextSpin = Date.now() + spinInterval;
    spinTimeoutId = setTimeout(runSpin, spinInterval);
  }

  res.json({
    players: roulettePlayers,
    nextSpin,
    serverTime: Date.now()
  });
});

// 3) Получить nextSpin + serverTime
app.get('/roulette/next-spin', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json({ nextSpin, serverTime: Date.now() });
});

// 4) Получить последний результат спина
app.get('/roulette/result', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  if (!lastSpinResult) {
    return res.status(404).json({ error: 'Результат пока недоступен' });
  }
  res.json(lastSpinResult);
});

app.get('/roulette/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(rouletteHistory);
});

/**
 * === Глобальный «КРАШ» ===
 * Логика: 
 * - currentCrash хранит текущий раунд (players, startTime, crashPoint, ended).
 * - Когда первый игрок делает join -> генерируем crashPoint, запоминаем startTime, запускаем таймер (например, 10 сек).
 * - Если через 10 сек никто не забылся (cashout), то в момент timeout всем участникам считается, что они проиграли.
 * - Если кто-то сделал cashout раньше, он получает свой выигрыш (и помечен как «выкупившийся»).
 * - После завершения (через 10 сек) формируем запись в crashHistory, сбрасываем currentCrash, чтобы в следующий раз создать новый при join.
 * - crashHistory держит последние 5 раундов.
 */


const BET_DELAY    = 10 * 1000;    // 10 сек фаза ставок
const BASE_SPEED   = 0.05;          // базовая скорость (в 1/sec)
const ACCEL        = 0.08;         // ускорение (в 1/sec²)

let currentCrash = {
  players: [],        // { username, bet, color, cashedOut, cashoutCoef, winnings }
  bettingEndTime: null, // когда завершается фаза ставок (timestamp)
  crashTime: null,    // когда наступит краш (timestamp)
  crashPoint: null,   // целевой коэффициент
  ended: true,        // true – раунд не идёт, false – фаза ставок или рост
  timerId: null       // setTimeout ID, чтобы можно было clearTimeout
};

let nextCrashPoint = null; // Заданный админом коэффициент для следующего раунда

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

function generateCrashPoint() {
  // Если админ задал коэффициент для следующего раунда, используем его
  if (nextCrashPoint !== null && nextCrashPoint > 1) {
    const cp = nextCrashPoint;
    nextCrashPoint = null; // Сбрасываем после использования
    return parseFloat(cp.toFixed(2));
  }
  
  // Иначе генерируем случайный
  const rand = Math.random() * 100;
  let cp;
  if (rand <= 75) {
    cp = Math.random() * (2 - 1) + 1;
  } else if (rand <= 90) {
    cp = Math.random() * (5 - 3) + 3;
  } else if (rand <= 95) {
    cp = Math.random() * (10 - 5) + 5;
  } else if (rand <= 98) {
    cp = Math.random() * (50 - 10) + 10;
  } else {
    cp = Math.random() * (1500 - 50) + 50;
  }
  return parseFloat(cp.toFixed(2));
}

/**
 * Завершает раунд: сохраняем в историю и сбрасываем currentCrash.
 */
function endCrashRound() {
  if (currentCrash.ended) return;

  const now = Date.now();
  const timestamp = now;
  const totalBet = currentCrash.players.reduce((sum, p) => sum + p.bet, 0);

  const snapshot = currentCrash.players.map((p) => ({
    username: p.username,
    bet: p.bet,
    cashedOut: p.cashedOut,
    cashoutCoef: p.cashedOut ? p.cashoutCoef : null,
    winnings: p.cashedOut ? p.winnings : 0,
    color: p.color
  }));

  const result = {
    timestamp,
    crashPoint: currentCrash.crashPoint,
    totalBet,
    players: snapshot
  };

  crashHistory.unshift(result);
  if (crashHistory.length > MAX_CRASH_HISTORY) crashHistory.pop();

  lastCrashResult = result; // сохраняем, чтобы /crash/state мог вернуть результат
  persistHistory();

  clearTimeout(currentCrash.timerId);
  currentCrash = {
    players: [],
    bettingEndTime: null,
    crashTime: null,
    crashPoint: null,
    ended: true,
    timerId: null
  };
}


/**
 * Запускает новый раунд:
 * 1) Генерация crashPoint.
 * 2) Вычисление T (в секундах), через которое coef = crashPoint:
 *       0.5*ACCEL*T² + BASE_SPEED*T + 1 - crashPoint = 0
 *    Решаем для T, берём положительный корень.
 * 3) Устанавливаем bettingEndTime = now + BET_DELAY.
 *    crashTime = bettingEndTime + T*1000.
 * 4) Ставим таймер setTimeout(endCrashRound, BET_DELAY + T*1000).
 */
function startNewCrashRound() {
  const now = Date.now();
  const cp = generateCrashPoint();
  currentCrash.crashPoint = cp;
  currentCrash.bettingEndTime = now + BET_DELAY;

  // Решаем квадратичное уравнение: 0.5·a·T² + b·T + (1 - cp) = 0, где b = BASE_SPEED, a = ACCEL
  const a = ACCEL / 2.0;
  const b = BASE_SPEED;
  const c = 1 - cp;

  const discriminant = b*b - 4*a*c;
  // Гарантированно discriminant ≥ 0, т.к. cp > 1, ACCEL > 0.
  const sqrtD = Math.sqrt(discriminant);
  const T = (-b + sqrtD) / (2*a); // положительный корень (T > 0)

  const timeToCrashMs = Math.floor(T * 1000);
  currentCrash.crashTime = currentCrash.bettingEndTime + timeToCrashMs;

  const totalDuration = BET_DELAY + timeToCrashMs;
  currentCrash.timerId = setTimeout(endCrashRound, totalDuration);
  currentCrash.ended = false;
  currentCrash.players = [];
  lastCrashResult = null;
}

// ========== ЭНДПОЙНТЫ «КРАШ» ==========

// Функция для проверки и выполнения автозабора
function checkAutoCashouts() {
  if (currentCrash.ended || !currentCrash.crashTime || !currentCrash.bettingEndTime) {
    return;
  }
  
  const now = Date.now();
  // Проверяем только во время роста коэффициента
  if (now < currentCrash.bettingEndTime || now >= currentCrash.crashTime) {
    return;
  }
  
  // Вычисляем текущий коэффициент
  const elapsedSec = Math.max(0, (now - currentCrash.bettingEndTime) / 1000);
  const currentCoef = 1 + BASE_SPEED * elapsedSec + 0.5 * ACCEL * elapsedSec * elapsedSec;
  
  // Проверяем всех игроков с автозабором
  currentCrash.players.forEach((participant) => {
    if (participant.cashedOut || !participant.autoCashout) {
      return;
    }
    
    // Если текущий коэффициент достиг или превысил целевой автозабора
    if (currentCoef >= participant.autoCashout && currentCoef < currentCrash.crashPoint) {
      // Выполняем автозабор
      const baseWinnings = participant.bet * participant.autoCashout;
      const commission = roundToCents(baseWinnings * (gameConfig.crashCommissionPercent / 100));
      const winnings = roundToCents(baseWinnings - commission);
      const userObj = findUser(participant.username);
      if (userObj) {
        updateUserBalance(participant.username, roundToCents(userObj.balance + winnings));
      }
      participant.cashedOut = true;
      participant.cashoutCoef = participant.autoCashout;
      participant.winnings = winnings;
    }
  });
}

// GET /crash/state → текущее состояние
app.get('/crash/state', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  
  // Проверяем автозаборы перед отправкой состояния
  checkAutoCashouts();
  
  res.json({
    players: currentCrash.players.map((p) => ({
      username: p.username,
      bet: p.bet,
      color: p.color,
      cashedOut: p.cashedOut,
      cashoutCoef: p.cashoutCoef,
      winnings: p.winnings
    })),
    bettingEndTime: currentCrash.bettingEndTime,
    crashTime: currentCrash.crashTime,
    crashPoint: currentCrash.ended ? currentCrash.crashPoint : null,
    ended: currentCrash.ended,
    serverTime: Date.now()
  });
});

// POST /crash/join { bet }
app.post('/crash/join', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { bet, autoCashout } = req.body;
  if (!bet || typeof bet !== 'number' || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const now = Date.now();

  // Если раунд не идёт – запускаем новый
  if (currentCrash.ended) {
    startNewCrashRound();
  }

  // Если уже позже, чем конец фазы ставок – отказ
  if (now > currentCrash.bettingEndTime) {
    return res.status(400).json({ error: 'Зона ставок закрыта, дождитесь следующего раунда' });
  }

  // Списываем баланс
  updateUserBalance(username, roundToCents(user.balance - bet));

  // Добавляем/увеличиваем ставку участника
  let existing = currentCrash.players.find((p) => p.username === username);
  const autoCashoutValue = (autoCashout && typeof autoCashout === 'number' && autoCashout > 1) ? autoCashout : null;
  if (existing) {
    existing.bet = roundToCents(existing.bet + bet);
    if (autoCashoutValue) {
      existing.autoCashout = autoCashoutValue;
    }
  } else {
    currentCrash.players.push({
      username,
      bet: roundToCents(bet),
      color: getRandomColor(),
      cashedOut: false,
      cashoutCoef: null,
      winnings: 0,
      autoCashout: autoCashoutValue // Коэффициент для автозабора
    });
  }

  const updatedUser = findUser(username);
  res.json({
    message: 'Ставка принята',
    newBalance: updatedUser ? updatedUser.balance : user.balance,
    players: currentCrash.players.map((p) => ({
      username: p.username,
      bet: p.bet,
      color: p.color,
      cashedOut: p.cashedOut,
      cashoutCoef: p.cashoutCoef,
      winnings: p.winnings
    })),
    bettingEndTime: currentCrash.bettingEndTime,
    crashTime: currentCrash.crashTime,
    ended: currentCrash.ended,
    serverTime: Date.now()
  });
});

// POST /crash/cashout { coefficient }
app.post('/crash/cashout', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { coefficient } = req.body;
  if (typeof coefficient !== 'number' || coefficient <= 1) {
    return res.status(400).json({ error: 'Некорректный коэффициент' });
  }

  if (currentCrash.ended) {
    return res.status(400).json({ error: 'Раунд уже завершён' });
  }

  const now = Date.now();

  // Если мы ещё в фазе ставок, cashout невозможен
  if (now < currentCrash.bettingEndTime) {
    return res.status(400).json({ error: 'Ещё не начался рост коэффициента' });
  }

  // Если уже после crashTime, никто не может забрать
  if (now >= currentCrash.crashTime) {
    const participantLate = currentCrash.players.find((p) => p.username === username);
    if (participantLate) {
      participantLate.cashedOut = false;
      participantLate.cashoutCoef = null;
      participantLate.winnings = 0;
    }
    return res.status(400).json({ error: 'Уже крашнулся, нет выплат' });
  }

  // Находим участника
  const participant = currentCrash.players.find((p) => p.username === username);
  if (!participant) {
    return res.status(400).json({ error: 'Вы не участвуете в текущем раунде' });
  }
  if (participant.cashedOut) {
    return res.status(400).json({ error: 'Вы уже забрали' });
  }

  // Если заявленный коэффициент ≥ crashPoint – опоздал
  if (coefficient >= currentCrash.crashPoint) {
    participant.cashedOut = false;
    participant.cashoutCoef = null;
    participant.winnings = 0;
    return res.status(400).json({ error: 'Уже крашнулся, нет выплат' });
  }

  // Иначе считаем выигрыш с учетом комиссии
  const baseWinnings = participant.bet * coefficient;
  const commission = roundToCents(baseWinnings * (gameConfig.crashCommissionPercent / 100));
  const winnings = roundToCents(baseWinnings - commission);
  const userObj = findUser(username);
  if (userObj) {
    updateUserBalance(username, userObj.balance + winnings);
  }
  participant.cashedOut = true;
  participant.cashoutCoef = coefficient;
  participant.winnings = winnings;

  const updatedUser = findUser(username);
  res.json({ winnings, newBalance: updatedUser ? updatedUser.balance : 0 });
});

// GET /crash/history → последние 5 раундов
app.get('/crash/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(crashHistory);
});

// ======= Коинфлип =======
app.get('/coinflip/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(coinflipHistory);
});

app.post('/coinflip/play', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { bet, choice } = req.body;
  const normalizedChoice = typeof choice === 'string' ? choice.toLowerCase() : '';

  if (!bet || typeof bet !== 'number' || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  if (!['heads', 'tails'].includes(normalizedChoice)) {
    return res.status(400).json({ error: 'Выберите сторону монеты' });
  }

  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const balanceAfterBet = roundToCents(user.balance - bet);
  updateUserBalance(username, balanceAfterBet);

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const win = result === normalizedChoice;
  const payout = win ? roundToCents(bet * gameConfig.coinflipMultiplier) : 0;
  let finalBalance = balanceAfterBet;
  if (win) {
    finalBalance = roundToCents(balanceAfterBet + payout);
    updateUserBalance(username, finalBalance);
  }

  const entry = {
    username,
    bet,
    choice: normalizedChoice,
    result,
    win,
    payout,
    timestamp: Date.now()
  };

  coinflipHistory.unshift(entry);
  if (coinflipHistory.length > MAX_COINFLIP_HISTORY) coinflipHistory.pop();
  persistHistory();

  res.json({
    result,
    win,
    payout,
    newBalance: finalBalance,
    history: coinflipHistory
  });
});

// ======= Дайс =======
app.get('/dice/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(diceHistory);
});

app.post('/dice/play', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { bet, percent, side } = req.body;
  if (!bet || typeof bet !== 'number' || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  const percentNum = Number(percent);
  if (!Number.isFinite(percentNum) || percentNum < 1 || percentNum > 99) {
    return res.status(400).json({ error: 'Процент должен быть от 1 до 99' });
  }
  if (!['less', 'more'].includes(side)) {
    return res.status(400).json({ error: 'Выберите меньше или больше' });
  }

  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const balanceAfterBet = roundToCents(user.balance - bet);
  updateUserBalance(username, balanceAfterBet);

  // Генерируем число от 0 до 999999
  const roll = Math.floor(Math.random() * 1000000);
  // Процент применяется к выбранной стороне
  let threshold;
  if (side === 'less') {
    // Для "меньше": процент применяется к "меньше"
    // При 1%: threshold = 10000, меньше = 0-9999 (1% шанс)
    threshold = Math.floor((percentNum / 100) * 1000000);
  } else {
    // Для "больше": процент применяется к "больше"
    // При 1%: threshold = 990000, больше = 990000-999999 (1% шанс, 10000 значений)
    threshold = Math.floor(((100 - percentNum) / 100) * 1000000);
  }
  const win = side === 'less' ? roll < threshold : roll >= threshold;
  const baseMultiplier = 100 / percentNum;
  const multiplier = baseMultiplier * (1 - gameConfig.diceCommissionPercent / 100);
  const payout = win ? roundToCents(bet * multiplier) : 0;
  let finalBalance = balanceAfterBet;
  if (win) {
    finalBalance = roundToCents(balanceAfterBet + payout);
    updateUserBalance(username, finalBalance);
  }

  const entry = {
    username,
    bet,
    percent: percentNum,
    side,
    roll,
    win,
    payout,
    timestamp: Date.now()
  };

  diceHistory.unshift(entry);
  if (diceHistory.length > MAX_DICE_HISTORY) diceHistory.pop();
  persistHistory();

  res.json({
    roll,
    win,
    payout,
    newBalance: finalBalance,
    history: diceHistory
  });
});

// ======= Плинко =======
app.get('/plinko/config', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(buildPlinkoConfig());
});

app.get('/plinko/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json(plinkoHistory);
});

app.post('/plinko/play', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const payload = req.body || {};
  const bet = Number(payload.bet);
  const riskRaw = typeof payload.risk === 'string' ? payload.risk.toLowerCase() : 'medium';
  const rowsInt = Number(payload.rows) || 12;
  const ballsCount = 1; // Всегда 1 шарик за раз (можно запускать несколько раз нажимая кнопку)

  if (!bet || !Number.isFinite(bet) || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  if (!PLINKO_ROWS.includes(rowsInt)) {
    return res.status(400).json({ error: 'Недопустимое количество рядов' });
  }
  const risk = PLINKO_RISKS.includes(riskRaw) ? riskRaw : 'medium';

  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  if (user.banned === true) {
    return res.status(403).json({ error: 'Аккаунт заблокирован' });
  }
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const balanceAfterBet = roundToCents(user.balance - bet);
  updateUserBalance(username, balanceAfterBet);

  const multipliers = ensurePlinkoMultipliers(risk, rowsInt);
  const results = [];
  let totalPayout = 0;

  for (let ballIdx = 0; ballIdx < ballsCount; ballIdx++) {
    let currentX = rowsInt / 2;
    let rightsCount = 0;
    const path = [currentX];
    for (let i = 0; i < rowsInt; i++) {
      const goRight = Math.random() >= 0.5;
      if (goRight) {
        rightsCount += 1;
        currentX += 0.5;
      } else {
        currentX -= 0.5;
      }
      path.push(currentX);
    }

    const bucketIndex = Math.min(Math.max(rightsCount, 0), multipliers.length - 1);
    const multiplier = multipliers[bucketIndex] || 0;
    const payout = multiplier > 0 ? roundToCents(bet * multiplier) : 0;
    totalPayout = roundToCents(totalPayout + payout);

    results.push({
      multiplier,
      payout,
      bucket: bucketIndex,
      path
    });

    const entry = {
      username,
      bet,
      risk,
      rows: rowsInt,
      multiplier,
      payout,
      bucket: bucketIndex,
      path,
      timestamp: Date.now()
    };
    plinkoHistory.unshift(entry);
  }

  if (plinkoHistory.length > MAX_PLINKO_HISTORY) {
    plinkoHistory.splice(MAX_PLINKO_HISTORY);
  }

  let finalBalance = balanceAfterBet;
  if (totalPayout > 0) {
    finalBalance = roundToCents(balanceAfterBet + totalPayout);
    updateUserBalance(username, finalBalance);
  }
  persistHistory();

  res.json({
    results,
    totalPayout,
    totalBet: bet,
    risk,
    rows: rowsInt,
    newBalance: finalBalance,
    history: plinkoHistory
  });
});

// ======= Промокоды =======
app.post('/promocode/activate', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Введите промокод' });
  }

  const promocodes = readPromocodes();
  const promocode = promocodes.find((p) => p.code.toLowerCase() === code.toLowerCase());
  if (!promocode) {
    return res.status(404).json({ error: 'Промокод не найден' });
  }

  const usage = readPromocodeUsage();
  const userUsed = usage[username] || [];
  if (userUsed.includes(promocode.code.toLowerCase())) {
    return res.status(400).json({ error: 'Вы уже использовали этот промокод' });
  }

  if (promocode.activationsLeft <= 0) {
    return res.status(400).json({ error: 'Промокод закончился' });
  }

  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  // Активируем промокод
  promocode.activationsLeft--;
  writePromocodes(promocodes);

  if (!usage[username]) usage[username] = [];
  usage[username].push(promocode.code.toLowerCase());
  
  // Сохраняем временную метку активации
  const codeLower = promocode.code.toLowerCase();
  const timestampKey = codeLower + '_timestamps';
  if (!usage[timestampKey]) usage[timestampKey] = {};
  usage[timestampKey][username] = Date.now();
  
  writePromocodeUsage(usage);

  const newBalance = user.balance + promocode.reward;
  updateUserBalance(username, newBalance);

  res.json({
    message: `Промокод активирован! Получено ${formatCoinsForClient(promocode.reward)}🍬`,
    reward: promocode.reward,
    newBalance
  });
});

// ======= Админ: Промокоды =======
app.get('/admin/promocodes', requireAdmin, (req, res) => {
  const promocodes = readPromocodes();
  res.json(promocodes);
});

app.post('/admin/promocodes', requireAdmin, (req, res) => {
  const { code, reward, activations } = req.body;
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Введите код промокода' });
  }
  if (!Number.isFinite(reward) || reward < 1) {
    return res.status(400).json({ error: 'Награда должна быть положительным числом' });
  }
  if (!Number.isInteger(activations) || activations < 1) {
    return res.status(400).json({ error: 'Количество активаций должно быть положительным целым числом' });
  }

  const promocodes = readPromocodes();
  const normalizedCode = code.trim().toLowerCase();
  if (promocodes.find((p) => p.code.toLowerCase() === normalizedCode)) {
    return res.status(400).json({ error: 'Промокод уже существует' });
  }

  const newPromocode = {
    code: code.trim(),
    reward: Math.floor(reward),
    activationsLeft: Math.floor(activations)
  };
  promocodes.push(newPromocode);
  writePromocodes(promocodes);

  res.json(newPromocode);
});

app.delete('/admin/promocodes/:code', requireAdmin, (req, res) => {
  const { code } = req.params;
  const promocodes = readPromocodes();
  const index = promocodes.findIndex((p) => p.code.toLowerCase() === code.toLowerCase());
  if (index === -1) {
    return res.status(404).json({ error: 'Промокод не найден' });
  }
  promocodes.splice(index, 1);
  writePromocodes(promocodes);
  res.json({ message: 'Промокод удалён' });
});

app.get('/admin/download/promocodes.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="promocodes.json"');
  res.sendFile(promocodesFile);
});

app.get('/admin/download/promocode-usage.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="promocode-usage.json"');
  res.sendFile(promocodeUsageFile);
});

app.get('/admin/download/yoomoney-payments.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="yoomoney-payments.json"');
  res.sendFile(yoomoneyPaymentsFile);
});

app.get('/admin/download/withdrawals.json', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="withdrawals.json"');
  res.sendFile(withdrawalsFile);
});

// ======= Админ: Управление конфигурацией игр =======
app.get('/admin/game-config', requireAdmin, (req, res) => {
  gameConfig = readGameConfig(); // Обновляем из файла
  res.json(gameConfig);
});

app.patch('/admin/game-config', requireAdmin, (req, res) => {
  const updates = req.body || {};
  gameConfig = readGameConfig();
  
  if (updates.coinflipMultiplier !== undefined) {
    const val = Number(updates.coinflipMultiplier);
    if (!Number.isFinite(val) || val <= 0 || val > 10) {
      return res.status(400).json({ error: 'Множитель коинфлипа должен быть от 0 до 10' });
    }
    gameConfig.coinflipMultiplier = val;
  }
  
  if (updates.diceCommissionPercent !== undefined) {
    const val = Number(updates.diceCommissionPercent);
    if (!Number.isFinite(val) || val < 0 || val > 50) {
      return res.status(400).json({ error: 'Комиссия дайса должна быть от 0 до 50%' });
    }
    gameConfig.diceCommissionPercent = val;
  }
  
  if (updates.rouletteCommissionPercent !== undefined) {
    const val = Number(updates.rouletteCommissionPercent);
    if (!Number.isFinite(val) || val < 0 || val > 50) {
      return res.status(400).json({ error: 'Комиссия рулетки должна быть от 0 до 50%' });
    }
    gameConfig.rouletteCommissionPercent = val;
  }
  
  if (updates.crashCommissionPercent !== undefined) {
    const val = Number(updates.crashCommissionPercent);
    if (!Number.isFinite(val) || val < 0 || val > 50) {
      return res.status(400).json({ error: 'Комиссия краша должна быть от 0 до 50%' });
    }
    gameConfig.crashCommissionPercent = val;
  }
  
  writeGameConfig(gameConfig);
  res.json(gameConfig);
});

// ======= Админ: Управление следующим коэффициентом краша =======
app.post('/admin/crash/next-point', requireAdmin, (req, res) => {
  const { crashPoint } = req.body;
  if (crashPoint === null || crashPoint === undefined) {
    nextCrashPoint = null;
    return res.json({ message: 'Следующий коэффициент краша сброшен' });
  }
  
  const val = Number(crashPoint);
  if (!Number.isFinite(val) || val <= 1) {
    return res.status(400).json({ error: 'Коэффициент должен быть больше 1' });
  }
  
  nextCrashPoint = val;
  res.json({ message: `Следующий коэффициент краша установлен: ${val.toFixed(2)}x`, crashPoint: val });
});

app.get('/admin/crash/next-point', requireAdmin, (req, res) => {
  res.json({ nextCrashPoint });
});

// === По умолчанию — отдаём index.html на корень ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
