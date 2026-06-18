import Customer from '../models/Customer.js';
import Order from '../models/Order.js';

export async function findOrCreateCustomer({ fullName, phone, email, shippingAddress }) {
  let customer = await Customer.findOne({ phone, fullName });

  if (!customer) {
    customer = await Customer.create({
      fullName,
      phone,
      email,
      addresses: shippingAddress
        ? [
            {
              label: 'Shipping',
              line1: shippingAddress.line1,
              line2: shippingAddress.line2,
              city: shippingAddress.city,
              zone: shippingAddress.zone,
              isDefault: true,
            },
          ]
        : [],
    });
  } else if (email && !customer.email) {
    customer.email = email;
    await customer.save();
  }

  await Customer.updateOne({ _id: customer._id }, { $inc: { lifetimeOrders: 1 } });
  return customer;
}

export async function getCustomerById(customerId) {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    const err = new Error('Customer not found');
    err.statusCode = 404;
    throw err;
  }

  const orders = await Order.find({ customerId })
    .sort({ placedAt: -1 })
    .limit(20)
    .select('shopifyOrderId internalStatus totalSellingPrice placedAt deliveredAt');

  const deliveryReliabilityScore =
    customer.lifetimeOrders > 0
      ? Math.round((customer.lifetimeDelivered / customer.lifetimeOrders) * 100)
      : null;

  return { customer, orders, deliveryReliabilityScore };
}

export async function updateCustomerRiskFlag(customerId, riskFlag) {
  return Customer.findByIdAndUpdate(customerId, { riskFlag }, { new: true });
}

export async function listCustomers({ search, limit = 50, skip = 0 }) {
  const filter = {};
  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Customer.countDocuments(filter),
  ]);
  return { customers, total };
}

export default { findOrCreateCustomer, getCustomerById, updateCustomerRiskFlag, listCustomers };
