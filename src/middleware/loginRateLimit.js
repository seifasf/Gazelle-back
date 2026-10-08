import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

function tooMany(req, res) {
  res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
}

/** Failed attempts per IP + email (successful logins do not count). */
export const loginAccountLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
  handler: tooMany,
});

/** All attempts per IP, so one address cannot spray many emails. */
export const loginIpLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: tooMany,
});

export default { loginAccountLimiter, loginIpLimiter };
