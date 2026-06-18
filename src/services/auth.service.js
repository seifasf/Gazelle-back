import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { config } from '../config/index.js';

export async function login(email, password) {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  if (!user) {
    const err = new Error('Invalid credentials');
    err.statusCode = 401;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const err = new Error('Invalid credentials');
    err.statusCode = 401;
    throw err;
  }

  user.lastLoginAt = new Date();
  await user.save();

  const token = jwt.sign({ sub: user._id.toString(), role: user.role }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  });

  return {
    token,
    user: { id: user._id, name: user.name, email: user.email, role: user.role },
  };
}

export async function createUser({ name, email, password, role }) {
  const passwordHash = await bcrypt.hash(password, 12);
  return User.create({ name, email, passwordHash, role });
}

export async function listUsers() {
  return User.find().select('-passwordHash').sort({ createdAt: -1 });
}

export async function deactivateUser(userId) {
  return User.findByIdAndUpdate(userId, { isActive: false }, { new: true }).select('-passwordHash');
}

export default { login, createUser, listUsers, deactivateUser };
