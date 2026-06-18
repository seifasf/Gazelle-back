import * as authService from '../services/auth.service.js';

export async function listUsers(req, res, next) {
  try {
    const users = await authService.listUsers();
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
}

export async function createUser(req, res, next) {
  try {
    const user = await authService.createUser(req.body);
    res.status(201).json({
      data: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

export async function deactivateUser(req, res, next) {
  try {
    const user = await authService.deactivateUser(req.params.id);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

export default { listUsers, createUser, deactivateUser };
