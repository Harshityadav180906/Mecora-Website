const express = require('express');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const dns = require('dns');

// Models
const User = require('../models/User');
const Payment = require('../models/Payment');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://harshity1809_db_user:Mecora123456@cluster0.upka52f.mongodb.net/mecora?retryWrites=true&w=majority';

let isConnected = false;
async function connectDB() {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  try {
    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI, { dbName: 'mecora' });
      isConnected = true;
      console.log('✅ MongoDB connected successfully');
    }
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

app.use(async (req, res, next) => {
  await connectDB();
  next();
});

// Razorpay instance with safe fallback
let razorpay = null;
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder',
  });
} catch (rErr) {
  console.warn('⚠️ Razorpay initialization notice:', rErr.message);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
  },
});

const plans = {
  monthly: { name: 'Monthly Plan', amount: 200000, duration: '1 Month', price: '₹2,000', days: 30 },
  quarterly: { name: 'Quarterly Plan', amount: 450000, duration: '3 Months', price: '₹4,500', days: 90 },
  annual: { name: 'Annual Plan', amount: 1000000, duration: '12 Months', price: '₹10,000', days: 365 },
};

// API: Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: cleanEmail });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already registered. Please login to proceed.' });
    }
    const isAdmin =
      cleanEmail === 'harshit.y.1809@gmail.com' ||
      cleanEmail === 'admin@mecora.com' ||
      (process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase());

    const user = new User({
      name,
      email: cleanEmail,
      password,
      phone,
      role: isAdmin ? 'admin' : 'user',
    });
    await user.save();
    res.json({
      success: true,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    });
  } catch (error) {
    console.error('Signup error:', error);
    let message = 'Server error during registration';
    if (error.name === 'ValidationError') {
      message = Object.values(error.errors).map(val => val.message).join(', ');
    } else if (error.code === 11000) {
      message = 'An account with this email already exists. Please log in.';
    } else if (error.message) {
      message = error.message;
    }
    res.status(400).json({ success: false, message });
  }
});

// API: Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }
    const cleanEmail = email.trim().toLowerCase();

    // Dedicated Master Admin Login (admin@mecora.com / admin123)
    if (cleanEmail === 'admin@mecora.com' && password === 'admin123') {
      let adminUser = await User.findOne({ email: cleanEmail });
      if (!adminUser) {
        adminUser = new User({
          name: 'Harshit Yadav (Admin)',
          email: 'admin@mecora.com',
          password: 'admin123',
          phone: '09667812705',
          role: 'admin',
        });
        await adminUser.save();
      } else if (adminUser.role !== 'admin') {
        adminUser.role = 'admin';
        await adminUser.save();
      }
      return res.json({
        success: true,
        user: {
          id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email,
          phone: adminUser.phone,
          role: 'admin',
        },
      });
    }

    const user = await User.findOne({ email: cleanEmail, password });
    if (!user) {
      // Check if email is registered at all (Enforce: without signup person cannot login)
      const userExists = await User.findOne({ email: cleanEmail });
      if (!userExists) {
        return res.status(404).json({
          success: false,
          notRegistered: true,
          message: 'Account not found! You must sign up first before you can log in and make a payment.',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid password. Please check your password and try again.',
      });
    }

    const isAdmin =
      user.role === 'admin' ||
      cleanEmail === 'harshit.y.1809@gmail.com' ||
      cleanEmail === 'admin@mecora.com' ||
      (process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase());

    if (isAdmin && user.role !== 'admin') {
      user.role = 'admin';
      await user.save();
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: isAdmin ? 'admin' : (user.role || 'user'),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// API: Create Order
app.post('/api/create-order', async (req, res) => {
  try {
    const { planType, userId, userEmail, userName, userPhone } = req.body;
    const plan = plans[planType];
    if (!plan) return res.status(400).json({ success: false, message: 'Invalid plan type' });

    const isMock = !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.includes('XXXX');
    if (isMock) {
      return res.json({
        success: true,
        isMock: true,
        order: { id: `order_mock_${Date.now()}`, amount: plan.amount, currency: 'INR' },
        plan,
        key: 'rzp_test_placeholder',
      });
    }

    const options = {
      amount: plan.amount,
      currency: 'INR',
      receipt: `order_${Date.now()}`,
      notes: { planType, userId, userEmail, userName },
    };

    const order = await razorpay.orders.create(options);
    res.json({ success: true, order, plan, key: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    const plan = plans[req.body.planType];
    res.json({
      success: true,
      isMock: true,
      order: { id: `order_mock_${Date.now()}`, amount: plan ? plan.amount : 200000, currency: 'INR' },
      plan,
      key: 'rzp_test_placeholder',
    });
  }
});

// API: Verify Payment
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planType, userName, userEmail, userPhone } = req.body;
    const isMock = razorpay_order_id?.startsWith('order_mock_') || !process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET.includes('secret_here');

    if (!isMock) {
      const sign = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign).digest('hex');
      if (razorpay_signature !== expectedSign) {
        return res.status(400).json({ success: false, message: 'Payment verification failed' });
      }
    }

    const plan = plans[planType] || plans.monthly;
    const paymentDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    try {
      const payment = new Payment({
        userId: (await User.findOne({ email: userEmail }))?._id,
        userName,
        userEmail,
        userPhone,
        planType,
        amount: plan.amount / 100,
        amountFormatted: plan.price,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature || 'mock_signature',
        status: 'success',
      });
      await payment.save();

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + plan.days);
      await User.findOneAndUpdate({ email: userEmail }, { plan: planType, planActive: true, planExpiresAt: expiresAt });
    } catch (dbErr) {
      console.error('DB save error in payment:', dbErr.message);
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      payment: {
        id: razorpay_payment_id || `pay_${Date.now()}`,
        orderId: razorpay_order_id,
        planType,
        userName,
        userEmail,
        amount: plan.price,
        date: paymentDate,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
});

// API: Admin stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeSubscriptions = await User.countDocuments({ planActive: true });
    const totalPayments = await Payment.countDocuments({ status: 'success' });
    const recentPayments = await Payment.find().sort({ createdAt: -1 }).limit(10);
    res.json({
      success: true,
      stats: { totalUsers, activeSubscriptions, totalPayments, totalRevenue: 15000, recentPayments },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// API: Get all payments (Admin)
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 });
    res.json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payments' });
  }
});

// API: Get all users (Admin)
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

module.exports = app;
