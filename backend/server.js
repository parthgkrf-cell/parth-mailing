require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./database');
const { startScheduler } = require('./services/scheduler');

const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const emailsRoutes = require('./routes/emails');
const masterRoutes = require('./routes/master');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Parth mailing',
    timestamp: new Date().toISOString(),
    complianceMode: 'Google Gmail Sender Guidelines 2024+'
  });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/emails', emailsRoutes);
app.use('/api/master', masterRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Bootstrapping
async function bootstrap() {
  try {
    await initDB();
    startScheduler();

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

