const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cors = require('cors');

const app = express();
// На Railway или другой PaaS порт берётся из переменной окружения
const PORT = process.env.PORT || 3000;

// --------------- CORS ---------------
const corsOptions = {
  origin: 'https://fen4yaragithubio-production.up.railway.app',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));

app.use(express.json());
// Статика: отдаём HTML/CSS/JS прямо из корня проекта
app.use(express.static(path.join(__dirname)));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://fen4yaragithubio-production-9286.up.railway.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});


const usersFile = path.join(__dirname, 'data', 'users.json');

// Убедимся, что data/users.json существует
const ensureUsersFileExists = () => {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]', 'utf-8');
};
ensureUsersFileExists();

// Вспомогательные функции для работы с users.json
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

  try {
    const all = readUsers();
    if (all.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }
    all.push({ username, balance: 100 });
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
// ======= /регистрация / login / check-auth / logout =======



let roulettePlayers = [];  
// Формат: [{ username, bet, color }]

let lastSpinResult = null;  
// Формат: { winner: String, totalBet: Number, timestamp: Number }

const spinInterval = 20000; // 20 сек
// Вычислим первый nextSpin: ближайшая «многократная» 20 000 мс
let nextSpin = Date.now() + spinInterval - (Date.now() % spinInterval);

// Вспомогательная функция для случайного цвета
function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

/**
 * runSpin() — вызывается автоматически каждые spinInterval.
 * Если игроков < 2 — просто очищает очередь без результатов.
 * Иначе выбирает случайного победителя пропорционально ставкам,
 * обновляет его баланс и заполняет lastSpinResult={…}.
 */
function runSpin() {
  const now = Date.now();
  if (roulettePlayers.length < 2) {
    // Недостаточно игроков → просто очистим очередь, без результата
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

  // После каждого runSpin пересчитаем следующий таймер
  nextSpin = nextSpin + spinInterval;
}

// Запустим initial spin через (nextSpin - Date.now()) мс, а затем интервалы
setTimeout(() => {
  runSpin();
  setInterval(runSpin, spinInterval);
}, nextSpin - Date.now());

// === Endpoint → вернуть список текущих игроков
app.get('/roulette/players', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json({ players: roulettePlayers });
});

// === Endpoint → игрок присоединяется (POST /roulette/join)
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

  // Если в очереди уже есть запись с этим username, просто добавляем новую ставку
  const existing = roulettePlayers.find(p => p.username === username);
  if (existing) {
    existing.bet += bet;
    // Цвет остаётся прежним
  } else {
    roulettePlayers.push({ username, bet, color: getRandomColor() });
  }

  res.json({ players: roulettePlayers });
});

// === Endpoint → следующая метка времени спина
app.get('/roulette/next-spin', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  res.json({ nextSpin });
});

// === Endpoint → последний результат спина (если уже был)
app.get('/roulette/result', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  if (!lastSpinResult) {
    return res.status(404).json({ error: 'Результат пока недоступен' });
  }
  res.json(lastSpinResult);
});

// ========== ЛОГИКА «КРАШ» ==========
const activeCrashGames = {};  // формат: { [username]: { bet, crashPoint, active } }

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
