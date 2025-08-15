// backend/models/Contact.js
const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true, trim: true },
    name: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Contact', contactSchema);