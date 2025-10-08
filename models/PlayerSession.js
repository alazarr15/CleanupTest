const mongoose = require('mongoose');

// This collection tracks every player currently in a session (lobby or active game).
const playerSessionSchema = new mongoose.Schema({
    // Link to the master game session (for easy querying of all players in a game)
    GameSessionId: { 
        type: String, 
        required: true,
        index: true 
    },
    // The player's unique identifier
    telegramId: { 
        type: String, // Assuming telegramId is stored as a string in your database based on existing usage
        required: true,
        index: true 
    },
    // The card the player took for this session
    cardId: { 
        type: Number, 
        required: true 
    },
    // Player's status: used for connection, failed payment, or final win/loss state
    status: {
        type: String,
        enum: ['connected', 'disconnected', 'failed_deduction', 'winner', 'loser'],
        default: 'connected',
        required: true,
    },
    
    joinedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// CRITICAL INDEX: Ensures a player can only hold one spot in one specific game session at a time.
playerSessionSchema.index({ telegramId: 1, GameSessionId: 1 }, { unique: true });

module.exports = mongoose.model('PlayerSession', playerSessionSchema);
