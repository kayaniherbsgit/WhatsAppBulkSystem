const mongoose = require('mongoose');

const contactSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    contacts: [
      {
        name: { type: String, default: '' },
        phone: { type: String, required: true, trim: true },
      },
    ],
  },
  { timestamps: true }
);

// Keep only the subfield index; `name` already has `unique: true` on the field.
contactSetSchema.index({ 'contacts.phone': 1 });

module.exports = mongoose.model('ContactSet', contactSetSchema);
