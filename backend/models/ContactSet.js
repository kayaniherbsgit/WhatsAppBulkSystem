const contactSetSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  contacts: [{ name: String, phone: String }],
  createdAt: { type: Date, default: Date.now }
});
const ContactSet = mongoose.model("ContactSet", contactSetSchema);
