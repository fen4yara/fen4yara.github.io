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
app.use(session({
  secret: 'mySecretKey',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
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
  return users.find(u => u.username === username);
}
function updateUserBalance(username, newBalance) {
  const users = readUsers();
  const idx = users.findIndex(u => u.username === username);
  if (idx !== -1) {
    users[idx].balance = newBalance;
    writeUsers(users);
    return true;
  }
  return false;
}

// ======= регистрация / login / check-auth / logout =======
app.post('/register', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const all = readUsers();
    if (all.find(u => u.ip === userIP)) {
      return res.status(400).json({ error: 'Регистрация с этого IP уже выполнена' });
    }
    if (all.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }
    all.push({ username, balance: 1000, ip: userIP });
    writeUsers(all);
    res.json({ message: 'Регистрация успешна!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  try {
    const user = findUser(username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    req.session.user = { username: user.username };
    res.json({
      message: 'Аутентификация успешна',
      user: {
        username: user.username,
        balance: user.balance
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при логине' });
  }
});

app.get('/check-auth', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  try {
    const user = findUser(req.session.user.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ username: user.username, balance: user.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера при проверке авторизации' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Ошибка при выходе' });
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Выход выполнен' });
  });
});
// ======= конец auth =======

let roulettePlayers = [];   // очередь: [{ username, bet, color }]
let lastSpinResult = null;  // { winner, totalBet, timestamp }
const spinInterval = 20000; // 20 сек

// Текущее запланированное время следующего спина (ms с эпохи). null, если пока не планировали.
let nextSpin = null;
let spinTimeoutId = null;

// Генератор случайного цвета для сектора
function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

/**
 * Запускает сам спин (выбирает победителя или очищает очередь),
 * записывает lastSpinResult, сбрасывает очередь.
 * Затем, если в очереди после спина снова ≥ 2 (теоретически это редко,
 * т. к. мы после каждого спина чистим очередь, но оставим проверку
 * «на всякий случай»), запускаем новый таймер;
 * иначе nextSpin остаётся null до следующего join.
 */
function runSpin() {
  const now = Date.now();
  if (roulettePlayers.length < 2) {
    // Если меньше двух — просто очищаем очередь без результата
    roulettePlayers = [];
    lastSpinResult = null;
  } else {
    const totalBet = roulettePlayers.reduce((sum, p) => sum + p.bet, 0);
    const randomAngle = Math.random() * 2 * Math.PI;

    let angleSum = 0;
    let winner = roulettePlayers[roulettePlayers.length - 1];
    for (let p of roulettePlayers) {
      const sliceAngle = (p.bet / totalBet) * 2 * Math.PI;
      if (randomAngle >= angleSum && randomAngle < angleSum + sliceAngle) {
        winner = p;
        break;
      }
      angleSum += sliceAngle;
    }

    // Обновляем баланс победителя
    const winUser = findUser(winner.username);
    if (winUser) {
      updateUserBalance(winner.username, winUser.balance + totalBet);
    }

    lastSpinResult = {
      winner: winner.username,
      totalBet: totalBet,
      timestamp: now
    };
    roulettePlayers = [];
  }

  // После спина сбрасываем nextSpin
  nextSpin = null;
  spinTimeoutId = null;

  // Если после спина в очереди (вдруг) снова ≥ 2, запускаем новый таймер
  if (roulettePlayers.length >= 2) {
    nextSpin = Date.now() + spinInterval;
    spinTimeoutId = setTimeout(runSpin, spinInterval);
  }
}

// === Endpoint → вернуть список текущих игроков ===
app.get('/roulette/players', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json({ players: roulettePlayers });
});

// === Endpoint → игрок присоединяется (POST /roulette/join) ===
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

  // Снимаем баланс
  updateUserBalance(username, user.balance - bet);

  // Если уже есть такой игрок — просто добавляем к его ставке
  const existing = roulettePlayers.find(p => p.username === username);
  if (existing) {
    existing.bet += bet;
  } else {
    roulettePlayers.push({ username, bet, color: getRandomColor() });
  }

  // Если после добавления стало ровно 2 игрока, запускаем «динамический» таймер
  if (roulettePlayers.length === 2 && nextSpin === null) {
    nextSpin = Date.now() + spinInterval;
    spinTimeoutId = setTimeout(runSpin, spinInterval);
  }

  res.json({ players: roulettePlayers });
});

// === Endpoint → следующая метка времени спина ===
app.get('/roulette/next-spin', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  // Если nextSpin === null, значит спин ещё не запланирован (менее 2 игроков)
  res.json({ nextSpin });
});

// === Endpoint → последний результат спина ===
app.get('/roulette/result', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  if (!lastSpinResult) {
    return res.status(404).json({ error: 'Результат пока недоступен' });
  }
  res.json(lastSpinResult);
});

// === Crash-игра (без изменений) ===
const activeCrashGames = {};
function generateCrashPoint() {
  const rand = Math.random() * 100;
  let cp;
  if (rand <= 50) {
    cp = (Math.random() * (2 - 1) + 1);
  } else if (rand <= 65) {
    cp = (Math.random() * (5 - 3) + 3);
  } else if (rand <= 80) {
    cp = (Math.random() * (10 - 5) + 5);
  } else if (rand <= 95) {
    cp = (Math.random() * (50 - 10) + 10);
  } else {
    cp = (Math.random() * (1500 - 50) + 50);
  }
  return parseFloat(cp.toFixed(2));
}

app.post('/crash/start', (req, res) => {
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
  const cp = generateCrashPoint();
  activeCrashGames[username] = { bet, crashPoint: cp, active: true };
  res.json({ crashPoint: cp });
});

app.post('/crash/cashout', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  const username = req.session.user.username;
  const { coefficient } = req.body;
  if (typeof coefficient !== 'number' || coefficient <= 1) {
    return res.status(400).json({ error: 'Некорректный коэффициент' });
  }

  const game = activeCrashGames[username];
  if (!game || !game.active) {
    return res.status(400).json({ error: 'Игра не найдена или уже завершена' });
  }

  if (coefficient >= game.crashPoint) {
    delete activeCrashGames[username];
    return res.status(400).json({ error: 'Уже крашнулся (нет выплат)' });
  }

  const winnings = Math.floor(game.bet * coefficient);
  const userObj = findUser(username);
  if (userObj) {
    updateUserBalance(username, userObj.balance + winnings);
  }

  delete activeCrashGames[username];
  res.json({ winnings, newBalance: findUser(username).balance });
});

// === По умолчанию — отдаём login.html на корень ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
