// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = '123456';
const ADMIN_PASSWORD = '123456';
const MAX_CRASH_HISTORY = 5;
const MAX_ROULETTE_HISTORY = 10;

// --------------- CORS ---------------
const corsOptions = {
  origin: 'https://fen4yaragithubio-production-9286.up.railway.app',
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
    const initial = { crashHistory: [], rouletteHistory: [] };
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
// ======= конец админки =======

let roulettePlayers = []; // текущая очередь: [{ username, bet, color }]
let lastSpinPlayers = null; // «снимок» очереди перед спином
let lastSpinResult = null; // { winner, totalBet, timestamp, players: lastSpinPlayers }
let rouletteHistory = [];
let crashHistory = [];
let lastCrashResult = null;

(() => {
  const store = readHistoryStore();
  let needsPersist = false;
  const rawRoulette = Array.isArray(store.rouletteHistory) ? store.rouletteHistory : [];
  const rawCrash = Array.isArray(store.crashHistory) ? store.crashHistory : [];
  rouletteHistory = rawRoulette.slice(0, MAX_ROULETTE_HISTORY);
  crashHistory = rawCrash.slice(0, MAX_CRASH_HISTORY);
  needsPersist = needsPersist || rawRoulette.length !== rouletteHistory.length || rawCrash.length !== crashHistory.length;
  if (rouletteHistory.length) {
    lastSpinResult = rouletteHistory[0];
  }
  if (crashHistory.length) {
    lastCrashResult = crashHistory[0];
  }
  if (needsPersist) {
    writeHistoryStore({ crashHistory, rouletteHistory });
  }
})();

function persistHistory() {
  writeHistoryStore({
    crashHistory,
    rouletteHistory
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

// === По умолчанию — отдаём index.html на корень ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
