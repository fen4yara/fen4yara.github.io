// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const https = require('https');
const querystring = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = '123456';
const ADMIN_PASSWORD = '123456';
const MAX_CRASH_HISTORY = 5;
const MAX_ROULETTE_HISTORY = 10;
const MAX_COINFLIP_HISTORY = 20;
const MAX_DICE_HISTORY = 20;
const MAX_DEPOSITS_FILE_RECORDS = 1000;
const MAX_DEPOSIT_HISTORY = 20;
const DEPOSIT_COOLDOWN_MS = 60 * 60 * 1000; // 1 час между пополнениями

// --------------- CORS ---------------
const corsOptions = {
  origin: 'https://fen4yaragithubio-production.up.railway.app',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(
  session({
    secret: 'mySecretKey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
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
const depositsFile = path.join(__dirname, 'data', 'deposits.json');
const promocodesFile = path.join(__dirname, 'data', 'promocodes.json');
const promocodeUsageFile = path.join(__dirname, 'data', 'promocode-usage.json');
const yoomoneyPaymentsFile = path.join(__dirname, 'data', 'yoomoney-payments.json');

// YooMoney API конфигурация
const YOOMONEY_API_TOKEN = '035C9025C933C61B6983BEF6FE1057707096DC0852888FA7CD453E30E0A98F7B';
const YOOMONEY_RECEIVER = process.env.YOOMONEY_RECEIVER || '79375809887'; // Номер кошелька получателя
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
      diceHistory: []
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

// Функция для создания платежа через YooMoney API
// Согласно документации: https://yoomoney.ru/docs/wallet
// API кошелька предназначен для платежей ИЗ кошелька, не для приема
// Для приема используем упрощенный подход с проверкой через operation-history
function createYooMoneyPayment(amount, label, returnUrl) {
  return new Promise((resolve, reject) => {
    if (!YOOMONEY_RECEIVER) {
      reject(new Error('Не указан номер кошелька получателя (YOOMONEY_RECEIVER)'));
      return;
    }

    // Создаем простую ссылку на форму перевода YooMoney
    // Пользователь перейдет на страницу перевода с предзаполненными данными
    const paymentUrl = `https://yoomoney.ru/quickpay/confirm?receiver=${YOOMONEY_RECEIVER}&sum=${amount}&label=${encodeURIComponent(label)}&quickpay-form=button&paymentType=AC`;
    
    // Возвращаем URL для перехода
    resolve({
      paymentUrl: paymentUrl,
      request_id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
  });
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
    users[idx].balance = newBalance;
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
app.post('/profile/yoomoney/create', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 50000) {
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
    // Создаем уникальный ID платежа
    const paymentId = `payment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const label = `Пополнение баланса для ${username} (${paymentId})`;
    const returnUrl = `https://fen4yaragithubio-production.up.railway.app/profile.html?payment=${paymentId}`;

    // Создаем платеж через YooMoney API
    const paymentData = await createYooMoneyPayment(amount, label, returnUrl);

    // Сохраняем информацию о платеже
    const payments = readYooMoneyPayments();
    payments.push({
      paymentId,
      username,
      amount,
      label,
      requestId: paymentData.request_id,
      status: 'pending',
      createdAt: Date.now()
    });
    writeYooMoneyPayments(payments);

    res.json({
      paymentId,
      paymentUrl: paymentData.paymentUrl,
      requestId: paymentData.request_id || paymentId
    });
  } catch (error) {
    console.error('Ошибка создания платежа YooMoney:', error);
    res.status(500).json({ error: 'Ошибка создания платежа: ' + error.message });
  }
});

// Webhook для обработки уведомлений от YooMoney
// YooMoney отправляет уведомления о входящих платежах
app.post('/profile/yoomoney/webhook', express.urlencoded({ extended: true }), (req, res) => {
  const { notification_type, operation_id, amount, label } = req.body;

  if (notification_type === 'p2p-incoming') {
    // Находим платеж по label
    const payments = readYooMoneyPayments();
    const payment = payments.find(p => p.label === label && p.status === 'pending');

    if (payment) {
      payment.status = 'success';
      payment.operationId = operation_id;
      payment.completedAt = Date.now();
      writeYooMoneyPayments(payments);

      // Пополняем баланс пользователя
      const user = findUser(payment.username);
      if (user) {
        const updatedBalance = user.balance + payment.amount;
        updateUserBalance(payment.username, updatedBalance);

        // Добавляем в историю депозитов
        const allDeposits = readDeposits();
        allDeposits.push({
          username: payment.username,
          amount: payment.amount,
          timestamp: Date.now(),
          method: 'yoomoney',
          paymentId: payment.paymentId
        });
        if (allDeposits.length > MAX_DEPOSITS_FILE_RECORDS) {
          allDeposits.splice(0, allDeposits.length - MAX_DEPOSITS_FILE_RECORDS);
        }
        writeDeposits(allDeposits);
      }
    }
  }

  res.status(200).send('OK');
});

// Функция для проверки входящих платежей через API YooMoney
// Проверяет operation-history и автоматически пополняет баланс
async function checkYooMoneyIncomingPayments() {
  try {
    // Получаем список входящих платежей через operation-history API
    const postData = querystring.stringify({
      type: 'deposition',
      records: '10' // Проверяем последние 10 операций
    });

    const options = {
      hostname: 'yoomoney.ru',
      path: '/api/operation-history',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${YOOMONEY_API_TOKEN}`
      }
    };

    const apiResponse = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            // YooMoney API может возвращать XML или form-urlencoded
            // Пытаемся распарсить как form-urlencoded
            const response = querystring.parse(data);
            resolve(response);
          } catch (err) {
            // Если не получилось, возвращаем сырые данные для дальнейшей обработки
            console.log('Ответ API не в формате form-urlencoded, пытаемся другой формат');
            resolve({ raw: data });
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    // Обрабатываем найденные платежи
    const payments = readYooMoneyPayments();
    const pendingPayments = payments.filter(p => p.status === 'pending');
    let processedCount = 0;

    // Если API вернул операции, проверяем их по label
    // API может вернуть операции в разных форматах, обрабатываем оба
    let operations = [];
    
    // Проверяем разные форматы ответа
    if (apiResponse.operations) {
      if (Array.isArray(apiResponse.operations)) {
        operations = apiResponse.operations;
      } else if (typeof apiResponse.operations === 'object') {
        operations = [apiResponse.operations];
      }
    } else if (apiResponse.raw) {
      // Если ответ в виде строки (XML или другой формат)
      const rawData = apiResponse.raw.toString();
      // Пытаемся найти label в ответе
      const labelMatches = rawData.match(/label[>=]["']([^"']+)["']/gi);
      if (labelMatches) {
        // Если нашли label, пытаемся извлечь информацию об операциях
        console.log('Найдены label в ответе API:', labelMatches.length);
      }
    }

    // Альтернативный способ: проверяем платежи по сумме и времени
    // Если платеж был создан недавно (в последние 10 минут), проверяем все входящие операции
    const now = Date.now();
    const recentPayments = pendingPayments.filter(p => {
      const timeDiff = now - p.createdAt;
      return timeDiff < 10 * 60 * 1000; // Последние 10 минут
    });

    console.log(`Проверяем ${recentPayments.length} ожидающих платежей из ${pendingPayments.length} всего`);

    // Если не нашли операции через API, используем альтернативный метод
    // Проверяем платежи по сумме и времени создания
    if (operations.length === 0 && recentPayments.length > 0) {
      console.log('Используем альтернативный метод проверки платежей');
      // В этом случае полагаемся на webhook или ручную проверку
      // Но можем попробовать найти платежи по сумме
    }

    for (const operation of operations) {
      if (operation && operation.label) {
        const payment = pendingPayments.find(p => {
          // Проверяем точное совпадение label или частичное (на случай изменений формата)
          return p.label === operation.label || 
                 (typeof operation.label === 'string' && operation.label.includes(p.paymentId)) ||
                 (typeof p.label === 'string' && p.label.includes(operation.label));
        });
        
        if (payment && !payment.operationId) {
          // Найден платеж, пополняем баланс
          const paymentIndex = payments.findIndex(p => p.paymentId === payment.paymentId);
          if (paymentIndex !== -1) {
            payments[paymentIndex].status = 'success';
            payments[paymentIndex].operationId = operation.operation_id || operation.operationId || 'unknown';
            payments[paymentIndex].completedAt = Date.now();
            writeYooMoneyPayments(payments);

            const user = findUser(payment.username);
            if (user) {
              const updatedBalance = user.balance + payment.amount;
              updateUserBalance(payment.username, updatedBalance);

              // Добавляем в историю депозитов
              const allDeposits = readDeposits();
              allDeposits.push({
                username: payment.username,
                amount: payment.amount,
                timestamp: Date.now(),
                method: 'yoomoney',
                paymentId: payment.paymentId
              });
              if (allDeposits.length > MAX_DEPOSITS_FILE_RECORDS) {
                allDeposits.splice(0, allDeposits.length - MAX_DEPOSITS_FILE_RECORDS);
              }
              writeDeposits(allDeposits);
              processedCount++;
              console.log(`✅ Платеж ${payment.paymentId} обработан, баланс пользователя ${payment.username} пополнен на ${payment.amount} руб.`);
            }
          }
        }
      }
    }

    return { processedCount, pendingCount: pendingPayments.length - processedCount };
  } catch (error) {
    console.error('Ошибка проверки платежей YooMoney:', error);
    return { error: error.message };
  }
}

// Эндпоинт для проверки входящих платежей через API
// Используется для периодической проверки статуса платежей
app.post('/profile/yoomoney/check-payments', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  const result = await checkYooMoneyIncomingPayments();
  res.json(result);
});

// Автоматическая проверка платежей каждые 30 секунд
setInterval(async () => {
  await checkYooMoneyIncomingPayments();
}, 30000); // Проверяем каждые 30 секунд

// Проверка статуса платежа
app.get('/profile/yoomoney/check/:paymentId', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  const { paymentId } = req.params;
  let payments = readYooMoneyPayments();
  let payment = payments.find(p => p.paymentId === paymentId && p.username === req.session.user.username);

  if (!payment) {
    return res.status(404).json({ error: 'Платеж не найден' });
  }

  // Если платеж еще pending, проверяем через API перед возвратом
  if (payment.status === 'pending') {
    console.log(`Проверяем платеж ${paymentId} для пользователя ${req.session.user.username}`);
    await checkYooMoneyIncomingPayments();
    // Обновляем данные платежа после проверки
    payments = readYooMoneyPayments();
    payment = payments.find(p => p.paymentId === paymentId);
    
    // Если платеж все еще pending, пытаемся найти его по сумме и времени
    if (payment && payment.status === 'pending') {
      console.log(`Платеж ${paymentId} все еще pending, пытаемся найти по сумме ${payment.amount}`);
      // Можно добавить дополнительную логику проверки
    }
  }

  const user = findUser(req.session.user.username);
  res.json({
    status: payment ? payment.status : 'pending',
    amount: payment ? payment.amount : 0,
    balance: user ? user.balance : 0
  });
});

// Эндпоинт для ручной проверки всех pending платежей пользователя
app.post('/profile/yoomoney/verify-payment/:paymentId', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  const { paymentId } = req.params;
  const payments = readYooMoneyPayments();
  const payment = payments.find(p => p.paymentId === paymentId && p.username === req.session.user.username);

  if (!payment) {
    return res.status(404).json({ error: 'Платеж не найден' });
  }

  if (payment.status !== 'pending') {
    return res.json({ message: 'Платеж уже обработан', status: payment.status });
  }

  // Выполняем проверку
  const result = await checkYooMoneyIncomingPayments();
  
  // Обновляем данные платежа
  const updatedPayments = readYooMoneyPayments();
  const updatedPayment = updatedPayments.find(p => p.paymentId === paymentId);
  const user = findUser(req.session.user.username);

  res.json({
    message: 'Проверка выполнена',
    status: updatedPayment ? updatedPayment.status : 'pending',
    amount: payment.amount,
    balance: user ? user.balance : 0,
    checkResult: result
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
  const { userDeposits } = getUserDepositsMeta(username);
  res.json({
    crash: userCrash,
    roulette: userRoulette,
    coinflip: userCoinflip,
    dice: userDice,
    deposits: userDeposits
  });
});
// ======= конец профиля =======

let roulettePlayers = []; // текущая очередь: [{ username, bet, color }]
let lastSpinPlayers = null; // «снимок» очереди перед спином
let lastSpinResult = null; // { winner, totalBet, timestamp, players: lastSpinPlayers }
let rouletteHistory = [];
let crashHistory = [];
let lastCrashResult = null;
let coinflipHistory = [];
let diceHistory = [];

(() => {
  const store = readHistoryStore();
  let needsPersist = false;
  const rawRoulette = Array.isArray(store.rouletteHistory) ? store.rouletteHistory : [];
  const rawCrash = Array.isArray(store.crashHistory) ? store.crashHistory : [];
  const rawCoinflip = Array.isArray(store.coinflipHistory) ? store.coinflipHistory : [];
  const rawDice = Array.isArray(store.diceHistory) ? store.diceHistory : [];
  rouletteHistory = rawRoulette.slice(0, MAX_ROULETTE_HISTORY);
  crashHistory = rawCrash.slice(0, MAX_CRASH_HISTORY);
  coinflipHistory = rawCoinflip.slice(0, MAX_COINFLIP_HISTORY);
  diceHistory = rawDice.slice(0, MAX_DICE_HISTORY);
  needsPersist =
    needsPersist ||
    rawRoulette.length !== rouletteHistory.length ||
    rawCrash.length !== crashHistory.length ||
    rawCoinflip.length !== coinflipHistory.length ||
    rawDice.length !== diceHistory.length;
  if (rouletteHistory.length) {
    lastSpinResult = rouletteHistory[0];
  }
  if (crashHistory.length) {
    lastCrashResult = crashHistory[0];
  }
  if (needsPersist) {
    writeHistoryStore({ crashHistory, rouletteHistory, coinflipHistory, diceHistory });
  }
})();

function persistHistory() {
  writeHistoryStore({
    crashHistory,
    rouletteHistory,
    coinflipHistory,
    diceHistory
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
    lastSpinPlayers = roulettePlayers.map((p) => ({ ...p }));

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
      updateUserBalance(winnerEntry.username, winUser.balance + totalBet);
    }

    lastSpinResult = {
      winner: winnerEntry.username,
      totalBet: totalBet,
      timestamp: now,
      players: lastSpinPlayers,
      winningTicket
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

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

function generateCrashPoint() {
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

// GET /crash/state → текущее состояние
app.get('/crash/state', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
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
  const { bet } = req.body;
  if (!bet || typeof bet !== 'number' || bet <= 0) {
    return res.status(400).json({ error: 'Некорректная ставка' });
  }
  const user = findUser(username);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
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
  updateUserBalance(username, user.balance - bet);

  // Добавляем/увеличиваем ставку участника
  let existing = currentCrash.players.find((p) => p.username === username);
  if (existing) {
    existing.bet += bet;
  } else {
    currentCrash.players.push({
      username,
      bet,
      color: getRandomColor(),
      cashedOut: false,
      cashoutCoef: null,
      winnings: 0
    });
  }

  res.json({
    message: 'Ставка принята',
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

  // Иначе считаем выигрыш
  const winnings = Math.floor(participant.bet * coefficient);
  const userObj = findUser(username);
  if (userObj) {
    updateUserBalance(username, userObj.balance + winnings);
  }
  participant.cashedOut = true;
  participant.cashoutCoef = coefficient;
  participant.winnings = winnings;

  res.json({ winnings, newBalance: findUser(username).balance });
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
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const balanceAfterBet = user.balance - bet;
  updateUserBalance(username, balanceAfterBet);

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const win = result === normalizedChoice;
  const payout = win ? bet * 2 : 0;
  let finalBalance = balanceAfterBet;
  if (win) {
    finalBalance += payout;
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
  if (user.balance < bet) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const balanceAfterBet = user.balance - bet;
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
  const multiplier = 100 / percentNum;
  const payout = win ? Math.floor(bet * multiplier) : 0;
  let finalBalance = balanceAfterBet;
  if (win) {
    finalBalance += payout;
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
  writePromocodeUsage(usage);

  const newBalance = user.balance + promocode.reward;
  updateUserBalance(username, newBalance);

  res.json({
    message: `Промокод активирован! Получено ${promocode.reward}🍬`,
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

// === По умолчанию — отдаём index.html на корень ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
