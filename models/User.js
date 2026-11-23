const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  phone: {
    type: String,
    required: true,
    trim: true,
  },
  plan: {
    type: String,
    enum: ['monthly', 'quarterly', 'annual', null],
    default: null,
  },
  planActive: {
    type: Boolean,
    default: false,
  },
  planExpiresAt: {
    type: Date,
    default: null,
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
}, {
  timestamps: true, // adds createdAt and updatedAt automatically
});

module.exports = mongoose.model('User', userSchema);
