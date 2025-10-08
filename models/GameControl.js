const mongoose = require('mongoose');

const gameControlSchema = new mongoose.Schema({
    GameSessionId: { type: String, required: true }, // unique ID per round
    gameId: { type: String, required: true },
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: String },
    stakeAmount: { type: Number, required: true },
    totalCards: { type: Number, required: true },
    prizeAmount: { type: Number, required: true },
    houseProfit: {
        type: Number,
        required: true,
    },
    endedAt: { type: Date },
});

gameControlSchema.index(
    { gameId: 1 }, 
    { 
        unique: true, 
        // Enforces uniqueness for ANY document that hasn't ended (isActive: true OR isActive: false)
        partialFilterExpression: { endedAt: { $eq: null } }, 
        name: "unique_current_session"
    }
);

// 3. FAST LOOKUP: Ensures quick retrieval by the unique session ID
gameControlSchema.index({ GameSessionId: 1 });

module.exports = mongoose.model('GameControl', gameControlSchema);