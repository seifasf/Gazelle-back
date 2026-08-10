import * as customerService from '../services/customer.service.js';

export async function listCustomers(req, res, next) {
  try {
    const result = await customerService.listCustomers(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function lookupByPhone(req, res, next) {
  try {
    const phone = req.query.phone || req.query.q;
    const result = await customerService.findCustomerByPhone(phone);
    if (!result) return res.json({ data: null });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getCustomer(req, res, next) {
  try {
    const result = await customerService.getCustomerById(req.params.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getCustomerOrders(req, res, next) {
  try {
    const result = await customerService.getCustomerShopifyOrders(req.params.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateRiskFlag(req, res, next) {
  try {
    const customer = await customerService.updateCustomerRiskFlag(req.params.id, req.body.riskFlag);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
}

export default { listCustomers, lookupByPhone, getCustomer, getCustomerOrders, updateRiskFlag };
