import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import LeaveRequest from '../models/LeaveRequest.js';
import User from '../models/User.js';
import bcrypt from 'bcrypt';
import { getEmployeeKpis } from './kpi.service.js';

function computeHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  return Math.max(0, (new Date(clockOut) - new Date(clockIn)) / (1000 * 60 * 60));
}

async function nextEmployeeCode() {
  const count = await Employee.countDocuments();
  return `EMP-${String(count + 1).padStart(4, '0')}`;
}

export async function listEmployees({ activeOnly = true } = {}) {
  const filter = activeOnly ? { isActive: true } : {};
  return Employee.find(filter)
    .populate('userId', 'name email role isActive lastLoginAt')
    .sort({ hireDate: -1 });
}

export async function getEmployee(id) {
  const employee = await Employee.findById(id).populate('userId', 'name email role isActive lastLoginAt');
  if (!employee) {
    const err = new Error('Employee not found');
    err.statusCode = 404;
    throw err;
  }
  return employee;
}

export async function createEmployee({
  userId,
  name,
  email,
  password,
  role,
  department,
  jobTitle,
  hireDate,
  salary,
  salaryType,
  bankAccount,
  emergencyContact,
}) {
  let user;
  if (userId) {
    user = await User.findById(userId);
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 400;
      throw err;
    }
  } else {
    if (!name || !email || !password || !role) {
      const err = new Error('name, email, password, and role required for new user');
      err.statusCode = 400;
      throw err;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    user = await User.create({ name, email, passwordHash, role, isActive: true });
  }

  const existing = await Employee.findOne({ userId: user._id });
  if (existing) {
    const err = new Error('Employee profile already exists for this user');
    err.statusCode = 400;
    throw err;
  }

  const employeeCode = await nextEmployeeCode();
  return Employee.create({
    userId: user._id,
    employeeCode,
    department: department || 'operations',
    jobTitle,
    hireDate: hireDate || new Date(),
    salary,
    salaryType: salaryType || 'monthly',
    bankAccount,
    emergencyContact,
  });
}

export async function updateEmployee(id, data) {
  return Employee.findByIdAndUpdate(id, data, { new: true, runValidators: true }).populate(
    'userId',
    'name email role isActive'
  );
}

export async function listAttendance(employeeId, { from, to, limit = 60 } = {}) {
  const filter = { employeeId };
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  return Attendance.find(filter).sort({ date: -1 }).limit(limit);
}

export async function recordAttendance({ employeeId, date, clockIn, clockOut, status, note, recordedBy }) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const hoursWorked = computeHours(clockIn, clockOut);

  return Attendance.findOneAndUpdate(
    { employeeId, date: day },
    {
      employeeId,
      date: day,
      clockIn: clockIn ? new Date(clockIn) : undefined,
      clockOut: clockOut ? new Date(clockOut) : undefined,
      hoursWorked,
      status: status || 'present',
      note,
      recordedBy,
    },
    { upsert: true, new: true }
  );
}

export async function listLeaveRequests({ status, employeeId, limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (employeeId) filter.employeeId = employeeId;

  const [requests, total] = await Promise.all([
    LeaveRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: 'employeeId', populate: { path: 'userId', select: 'name email role' } })
      .populate('reviewedBy', 'name'),
    LeaveRequest.countDocuments(filter),
  ]);
  return { requests, total };
}

export async function createLeaveRequest(data) {
  return LeaveRequest.create(data);
}

export async function reviewLeaveRequest(id, { status, reviewedBy }) {
  return LeaveRequest.findByIdAndUpdate(
    id,
    { status, reviewedBy, reviewedAt: new Date() },
    { new: true }
  );
}

export async function getPayrollSummary(month) {
  const [year, mon] = (month || new Date().toISOString().slice(0, 7)).split('-').map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 0, 23, 59, 59);

  const employees = await Employee.find({ isActive: true }).populate('userId', 'name email role');

  const rows = [];
  for (const emp of employees) {
    const attendance = await Attendance.find({
      employeeId: emp._id,
      date: { $gte: start, $lte: end },
      status: { $in: ['present', 'late', 'half_day'] },
    });
    const daysWorked = attendance.length;
    const hoursWorked = attendance.reduce((s, a) => s + (a.hoursWorked || 0), 0);

    let grossPay = 0;
    if (emp.salaryType === 'hourly') grossPay = (emp.salary || 0) * hoursWorked;
    else grossPay = daysWorked > 0 ? ((emp.salary || 0) / 22) * daysWorked : 0;

    rows.push({
      employeeId: emp._id,
      employeeCode: emp.employeeCode,
      name: emp.userId?.name,
      role: emp.userId?.role,
      department: emp.department,
      salary: emp.salary,
      salaryType: emp.salaryType,
      daysWorked,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      grossPay: Math.round(grossPay * 100) / 100,
    });
  }

  return { month: month || `${year}-${String(mon).padStart(2, '0')}`, rows };
}

export async function getEmployeeProfileWithKpis(id, { from, to } = {}) {
  const employee = await getEmployee(id);
  const kpis = await getEmployeeKpis(employee.userId._id, { from, to });
  const [attendance, leaves] = await Promise.all([
    listAttendance(id, { limit: 30 }),
    listLeaveRequests({ employeeId: id, limit: 20 }),
  ]);
  return { employee, kpis, attendance, leaves: leaves.requests };
}

export default {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  listAttendance,
  recordAttendance,
  listLeaveRequests,
  createLeaveRequest,
  reviewLeaveRequest,
  getPayrollSummary,
  getEmployeeProfileWithKpis,
};
