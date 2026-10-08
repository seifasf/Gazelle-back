import { stripFinancialFields } from '../utils/stripFinancialFields.js';

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export function adminOnly(req, res, next) {
  return requireRoles('admin')(req, res, next);
}

export { stripFinancialFields };

export function sanitizeFinancialResponse(req, res, next) {
  const role = req.user?.role;
  if (role === 'admin') return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(stripFinancialFields(body, role));
  next();
}

export default { requireRoles, adminOnly, stripFinancialFields, sanitizeFinancialResponse };
