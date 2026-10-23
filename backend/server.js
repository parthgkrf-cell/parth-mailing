require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB, get } = require('./database');
const { startScheduler } = require('./services/scheduler');
const { startAccountSync } = require('./services/accountSync');

const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const emailsRoutes = require('./routes/emails');
const masterRoutes = require('./routes/master');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5000',
    'http://127.0.0.1:5000'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const row = await get('SELECT value FROM system_settings WHERE key = ?', ['app_name']);
    res.json({
      status: 'ok',
      app: row?.value || 'Parth mailing',
      timestamp: new Date().toISOString(),
      complianceMode: 'Google Gmail Sender Guidelines 2024+'
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: 'Health check failed' });
  }
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/emails', emailsRoutes);
app.use('/api/master', masterRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Bootstrapping
async function bootstrap() {
  try {
    await initDB();
    startScheduler();
    startAccountSync();

    app.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(`  Parth mailing Backend running on http://localhost:${PORT}`);
      console.log(`  Gmail Policy Compliance: STRICT (500 max/day, safe pacing)`);
      console.log(`  Master Admin login ready.`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Failed to bootstrap server:', err);
    process.exit(1);
  }
}

bootstrap();

