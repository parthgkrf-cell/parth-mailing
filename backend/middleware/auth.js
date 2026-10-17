const jwt = require('jsonwebtoken');
const { get } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'parth_mailing_super_secure_jwt_secret_key_2026';

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required. Please login.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await get('SELECT id, name, email, role, is_active, is_approved FROM users WHERE id = ?', [decoded.id]);
    if (!user) {
      return res.status(401).json({ error: 'User no longer exists.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated by the Master Admin.' });
    }

    if (!user.is_approved) {
      return res.status(403).json({ error: 'Your account is pending Master Admin approval.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please login again.' });
  }
};

const requireMaster = async (req, res, next) => {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'master') {
      return res.status(403).json({ error: 'Access restricted to Master Admin only.' });
    }
    next();
  });
};

module.exports = {
  requireAuth,
  requireMaster,
  JWT_SECRET
};

