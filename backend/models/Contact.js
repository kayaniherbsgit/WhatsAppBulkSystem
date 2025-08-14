const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  name: String
});

module.exports = mongoose.model("Contact", contactSchema);