// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.static(path.join(__dirname)));

const usersFile = path.join(__dirname, 'data', 'users.json');
const ensureUsersFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]', 'utf-8');
};
ensureUsersFileExists();

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

    all.push({ username, passwordHash, balance: 1000, ip: userIP });
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

let roulettePlayers = []; // текущая очередь: [{ username, bet, color }]
let lastSpinPlayers = null; // «снимок» очереди перед спином
let lastSpinResult = null; // { winner, totalBet, timestamp, players: lastSpinPlayers }
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
    const randomAngle = Math.random() * 2 * Math.PI;

    let angleSum = 0;
    let winnerEntry = lastSpinPlayers[lastSpinPlayers.length - 1];
    for (let p of lastSpinPlayers) {
      const sliceAngle = (p.bet / totalBet) * 2 * Math.PI;
      if (randomAngle >= angleSum && randomAngle < angleSum + sliceAngle) {
        winnerEntry = p;
        break;
      }
      angleSum += sliceAngle;
    }

    const winUser = findUser(winnerEntry.username);
    if (winUser) {
      updateUserBalance(winnerEntry.username, winUser.balance + totalBet);
    }

    lastSpinResult = {
      winner: winnerEntry.username,
      totalBet: totalBet,
      timestamp: now,
      players: lastSpinPlayers
    };

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

const CRASH_ROUND_DURATION = 10 * 1000; // 10 секунд на раунд
const CRASH_GROWTH_SPEED = 0.2; // коэф растёт: coef = 1 + elapsedSeconds * 0.2

let currentCrash = {
  players: [],      // { username, bet, color, cashedOut: bool, cashoutCoef: number, winnings: number }
  startTime: null,  // timestamp в ms
  crashPoint: null, // число, например 3.45
  ended: true,      // true → раунд не запущен, false → идёт раунд
  timerId: null     // id таймера, чтобы можно было clearTimeout
};

let crashHistory = []; // массив последних 5 раундов: 
// { timestamp, crashPoint, totalBet, players: [ { username, bet, cashedOut, cashoutCoef, winnings } ] }

/**
 * Генератор случайного цвета.
 */
function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

/**
 * Генерация CrashPoint при старте раунда. 
 * Можно оставить ту же логику, что и раньше.
 */
function generateCrashPoint() {
  const rand = Math.random() * 100;
  let cp;
  if (rand <= 50) {
    cp = Math.random() * (2 - 1) + 1;
  } else if (rand <= 65) {
    cp = Math.random() * (5 - 3) + 3;
  } else if (rand <= 80) {
    cp = Math.random() * (10 - 5) + 5;
  } else if (rand <= 95) {
    cp = Math.random() * (50 - 10) + 10;
  } else {
    cp = Math.random() * (1500 - 50) + 50;
  }
  return parseFloat(cp.toFixed(2));
}

/**
 * Функция, которая вызывается через CRASH_ROUND_DURATION после старта раунда.
 * Завершает текущий раунд, сохраняет в историю, сбрасывает currentCrash.
 */
function endCrashRound() {
  if (currentCrash.ended) return; // если уже закончился

  // Считаем, что в этот момент коэффициент = crashPoint (все, кто не успел cashout, проиграли).
  const finalCoef = currentCrash.crashPoint;
  const timestamp = Date.now();
  const totalBet = currentCrash.players.reduce((sum, p) => sum + p.bet, 0);

  // Для тех, кто не cashedOut, winnings = 0. 
  // Для тех, кто успел cashedOut (cashoutCoef < crashPoint), у нас уже посчитано.
  // Запишем snapshot:
  const snapshot = currentCrash.players.map((p) => ({
    username: p.username,
    bet: p.bet,
    cashedOut: p.cashedOut,
    cashoutCoef: p.cashedOut ? p.cashoutCoef : null,
    winnings: p.cashedOut ? p.winnings : 0,
    color: p.color
  }));

  // Формируем запись истории:
  crashHistory.unshift({
    timestamp,
    crashPoint: finalCoef,
    totalBet,
    players: snapshot
  });
  if (crashHistory.length > 5) crashHistory.pop();

  // Сбрасываем currentCrash:
  clearTimeout(currentCrash.timerId);
  currentCrash = {
    players: [],
    startTime: null,
    crashPoint: null,
    ended: true,
    timerId: null
  };
}

/**
 * Запускаем новый раунд: заполняем currentCrash.crashPoint, берём текущее время, 
 * ставим ended = false, запускаем таймер на CRASH_ROUND_DURATION.
 */
function startNewCrashRound() {
  currentCrash.crashPoint = generateCrashPoint();
  currentCrash.startTime = Date.now();
  currentCrash.ended = false;
  currentCrash.timerId = setTimeout(endCrashRound, CRASH_ROUND_DURATION);
  // players уже заполнен (минимум 1 игрок поставил)
}

// ========== ЭНДПОЙНТЫ «КРАШ» ==========

// 1) Получить состояние текущего раунда: 
//    - players (без выпадений/общих полей) 
//    - startTime 
//    - ended (булево) 
//    - crashPoint (если раунд уже закончился, иначе null) 
//    - serverTime (для расчёта коэффициента на клиенте)
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
    startTime: currentCrash.startTime,
    ended: currentCrash.ended,
    crashPoint: currentCrash.ended ? currentCrash.crashPoint : null,
    serverTime: Date.now()
  });
});

// 2) Присоединиться к раунду (сделать ставку): POST /crash/join { bet: number }
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

  // Если раунд ещё не запущен (ended = true), запускаем новый:
  if (currentCrash.ended) {
    currentCrash.players = [];
    currentCrash.ended = false;
    startNewCrashRound();
  }

  // Теперь проверяем, что ставка делается до того, как crashPoint уже наступил:
  const now = Date.now();
  if (now - currentCrash.startTime >= CRASH_ROUND_DURATION) {
    // Если раунд уже должен был закончиться (чаще бывает, если приходят сразу после тайм-аута),
    // просто даём ошибку, что нужно подождать следующий раунд.
    return res.status(400).json({ error: 'Раунд уже завершён, дождитесь следующего' });
  }

  // Списываем баланс
  updateUserBalance(username, user.balance - bet);

  // Добавляем (или увеличиваем) участника:
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
    startTime: currentCrash.startTime,
    ended: currentCrash.ended,
    serverTime: Date.now()
  });
});

// 3) Забрать (cashout): POST /crash/cashout { coefficient: number }
app.post('/crash/cashout', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { coefficient } = req.body;
  if (typeof coefficient !== 'number' || coefficient <= 1) {
    return res.status(400).json({ error: 'Некорректный коэффициент' });
  }

  // Если раунд уже завершён:
  if (currentCrash.ended) {
    return res.status(400).json({ error: 'Раунд уже завершён' });
  }

  // Находим игрока:
  const participant = currentCrash.players.find((p) => p.username === username);
  if (!participant) {
    return res.status(400).json({ error: 'Вы не участвуете в текущем раунде' });
  }
  if (participant.cashedOut) {
    return res.status(400).json({ error: 'Вы уже забрали' });
  }

  // Проверяем, не наступил ли уже краш:
  const now = Date.now();
  const elapsed = (now - currentCrash.startTime) / 1000; // секунды, прошедшие с запуска
  const clientCoef = 1 + elapsed * CRASH_GROWTH_SPEED;
  // Но реальный момент краша хранится в currentCrash.crashPoint (например, 3.45).
  // Если запрошенный coefficient >= crashPoint → значит, игрок «опоздал» и проиграл.
  if (coefficient >= currentCrash.crashPoint) {
    participant.cashedOut = false;
    participant.cashoutCoef = null;
    participant.winnings = 0;
    return res.status(400).json({ error: 'Уже крашнулся, нет выплат' });
  }

  // Иначе считаем выигрыш:
  const winnings = Math.floor(participant.bet * coefficient);
  // Добавляем на баланс:
  const user = findUser(username);
  if (user) {
    updateUserBalance(username, user.balance + winnings);
  }
  // Запоминаем, что он успел:
  participant.cashedOut = true;
  participant.cashoutCoef = coefficient;
  participant.winnings = winnings;

  res.json({ winnings, newBalance: findUser(username).balance });
});

// 4) История последних 5 раундов: GET /crash/history
app.get('/crash/history', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  // Отдаём crashHistory, где каждый элемент:
  // { timestamp, crashPoint, totalBet, players: [ { username, bet, cashedOut, cashoutCoef, winnings, color } ] }
  res.json(crashHistory);
});

// === По умолчанию — отдаём login.html на корень ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
