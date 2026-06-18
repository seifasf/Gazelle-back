import * as authService from '../services/auth.service.js';

export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function me(req, res) {
  res.json({ user: req.user });
}

export default { login, me };
