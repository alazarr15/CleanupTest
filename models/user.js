const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: { type: String, default: "Unknown" },
    phoneNumber: { type: String, required: true },
    balance: { type: Number, default: 0 },
    bonus_balance: {  type: Number, default: 0,},
    registeredAt: { type: Date, default: Date.now },
    transferInProgress: {
        type: Object,
        default: null, 
    },
    // 🟢 New field to lock a user's spot in a game without deducting their balance immediately
    reservedForGameId: { type: String, default: null }
});

//userSchema.index({ telegramId: 1 }); 
module.exports = mongoose.model("User", userSchema);
