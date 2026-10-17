const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run } = require('../database');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check duplicate
    const existing = await get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Check approval setting
    const settingRow = await get('SELECT value FROM system_settings WHERE key = "require_user_approval"');
    const requiresApproval = settingRow ? settingRow.value === '1' : false;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, is_active, is_approved)
       VALUES (?, ?, ?, 'user', 1, ?)`,
      [name.trim(), cleanEmail, passwordHash, requiresApproval ? 0 : 1]
    );

    if (requiresApproval) {
      return res.status(201).json({
        message: 'Account registered successfully! It is pending approval by Master Admin before you can access.',
        requiresApproval: true
      });
    }

    // Auto login
    const token = jwt.sign(
      { id: result.lastID, email: cleanEmail, role: 'user' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'Registration successful!',
      token,
      user: {
        id: result.lastID,
        name: name.trim(),
        email: cleanEmail,
        role: 'user',
        is_active: 1,
        is_approved: 1
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await get('SELECT * FROM users WHERE email = ?', [cleanEmail]);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account disabled. Contact Master Admin.' });
    }

    if (!user.is_approved) {
      return res.status(403).json({ error: 'Account is pending Master Admin approval.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        is_active: user.is_active,
        is_approved: user.is_approved
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// Get profile
router.get('/me', requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

module.exports = router;

