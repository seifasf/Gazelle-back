import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import User from '../models/User.js';

export async function authenticate(req, res, next) {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, config.JWT_SECRET);
    const user = await User.findById(payload.sub).select('-passwordHash');
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function optionalAuth(req, res, next) {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return next();
  return authenticate(req, res, next);
}

export default { authenticate, optionalAuth };
