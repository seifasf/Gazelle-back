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

const FINANCIAL_FIELDS = ['cogs', 'unitCogs', 'totalCogsSnapshot'];

export function stripFinancialFields(obj, role) {
  if (role === 'admin' || !obj) return obj;
  if (Array.isArray(obj)) return obj.map((item) => stripFinancialFields(item, role));
  if (typeof obj !== 'object') return obj;

  const plain = obj.toObject ? obj.toObject() : { ...obj };
  for (const key of FINANCIAL_FIELDS) {
    delete plain[key];
  }
  if (plain.items) {
    plain.items = plain.items.map((item) => stripFinancialFields(item, role));
  }
  return plain;
}

export function sanitizeFinancialResponse(req, res, next) {
  const role = req.user?.role;
  if (role === 'admin') return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body?.data) {
      body.data = stripFinancialFields(body.data, role);
    } else {
      body = stripFinancialFields(body, role);
    }
    return originalJson(body);
  };
  next();
}

export default { requireRoles, adminOnly, stripFinancialFields, sanitizeFinancialResponse };
