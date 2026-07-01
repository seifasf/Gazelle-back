import * as hrService from '../services/hr.service.js';
import { getEmployeeKpis } from '../services/kpi.service.js';

export async function listEmployees(req, res, next) {
  try {
    const employees = await hrService.listEmployees({ activeOnly: req.query.activeOnly !== 'false' });
    res.json({ data: employees });
  } catch (err) {
    next(err);
  }
}

export async function getEmployee(req, res, next) {
  try {
    const profile = await hrService.getEmployeeProfileWithKpis(req.params.id, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data: profile });
  } catch (err) {
    next(err);
  }
}

export async function createEmployee(req, res, next) {
  try {
    const employee = await hrService.createEmployee(req.body);
    res.status(201).json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function updateEmployee(req, res, next) {
  try {
    const employee = await hrService.updateEmployee(req.params.id, req.body);
    res.json({ data: employee });
  } catch (err) {
    next(err);
  }
}

export async function listAttendance(req, res, next) {
  try {
    const records = await hrService.listAttendance(req.params.id, req.query);
    res.json({ data: records });
  } catch (err) {
    next(err);
  }
}

export async function recordAttendance(req, res, next) {
  try {
    const record = await hrService.recordAttendance({
      employeeId: req.params.id,
      ...req.body,
      recordedBy: req.user._id,
    });
    res.json({ data: record });
  } catch (err) {
    next(err);
  }
}

export async function getKpis(req, res, next) {
  try {
    const employee = await hrService.getEmployee(req.params.id);
    const kpis = await getEmployeeKpis(employee.userId._id, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data: kpis });
  } catch (err) {
    next(err);
  }
}

export async function listLeaveRequests(req, res, next) {
  try {
    const result = await hrService.listLeaveRequests({
      status: req.query.status,
      employeeId: req.query.employeeId,
      limit: Number(req.query.limit) || 50,
      skip: Number(req.query.skip) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function createLeaveRequest(req, res, next) {
  try {
    const request = await hrService.createLeaveRequest(req.body);
    res.status(201).json({ data: request });
  } catch (err) {
    next(err);
  }
}

export async function reviewLeaveRequest(req, res, next) {
  try {
    const request = await hrService.reviewLeaveRequest(req.params.id, {
      status: req.body.status,
      reviewedBy: req.user._id,
    });
    res.json({ data: request });
  } catch (err) {
    next(err);
  }
}

export async function payrollSummary(req, res, next) {
  try {
    const summary = await hrService.getPayrollSummary(req.query.month);
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
}

export default {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  listAttendance,
  recordAttendance,
  getKpis,
  listLeaveRequests,
  createLeaveRequest,
  reviewLeaveRequest,
  payrollSummary,
};
