require("dotenv").config();
const mongoose = require('mongoose');
const { createClient } = require("redis");
const connectDB = require("./config/db");

// Import Mongoose Models
const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameCard = require('./models/GameCard');
const PlayerSession = require("./models/PlayerSession");

console.log("🛠️  Starting disconnect cleanup worker...");

// --- Main Worker Logic ---
async function startWorker() {
    try {
        // 1. Connect to MongoDB
        await connectDB();
        console.log("✅ Worker connected to MongoDB.");

        // 2. Connect to Redis
        const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
        const redis = createClient({ url: redisUrl });
        await redis.connect();
        console.log("✅ Worker connected to Redis.");

        console.log("... Worker is now listening for cleanup jobs ...\n");

        // 3. Infinite loop to process jobs from the queue
        while (true) {
            try {
                // Use BRPOP to wait for a job to appear in the list.
                const result = await redis.brPop('disconnect-cleanup-queue', 0);
                const jobPayload = result.element;
                const job = JSON.parse(jobPayload);

                console.log(`\n▶️  Processing job for User: ${job.telegramId}, Game: ${job.gameId}, Phase: ${job.phase}`);

                // 4. Route the job to the correct cleanup logic based on the phase
                if (job.phase === 'lobby') {
                    await processLobbyCleanup(job, redis);
                } else if (job.phase === 'joinGame') {
                    await processJoinGameCleanup(job, redis);
                } else {
                    console.warn(`⚠️ Unknown job phase received: ${job.phase}`);
                }

            } catch (error) {
                console.error("❌ CRITICAL ERROR in worker loop:", error);
                // Wait for a short period before retrying to prevent rapid-fire errors
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    } catch (error) {
        console.error("❌ Worker failed to start:", error);
        process.exit(1); // Exit if essential connections fail
    }
}


  // --- Logic for Lobby Phase Cleanup (UPDATED TO MATCH playerLeave) ---
async function processLobbyCleanup(job, redis) {
    const { telegramId, gameId, gameSessionId } = job;
    // ✅ Trim the ID just like playerLeave
    const strTelegramId = String(telegramId).trim(); 
    const strGameId = String(gameId);
    
    console.log(`   -> Executing LOBBY cleanup for ${telegramId}`);

    try {
        const gameCardsKey = `gameCards:${strGameId}`;

        // 1. REDIS CLEANUP: Scan Redis directly (Source of Truth)
        const allGameCards = await redis.hGetAll(gameCardsKey);
        
        // ✅ Filter using trim() to ensure we catch the cards
        const cardsToRelease = Object.entries(allGameCards)
            .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
            .map(([cardId]) => cardId);

        if (cardsToRelease.length > 0) {
            console.log(`   -> Found ${cardsToRelease.length} cards in Redis to release: ${cardsToRelease.join(', ')}`);

            // A) Remove from Redis
            await redis.hDel(gameCardsKey, ...cardsToRelease);

            // B) Update MongoDB 
            await GameCard.updateMany(
                { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                { $set: { isTaken: false, takenBy: null } }
            );

            // ✅ Double-Check for leftovers (Race Condition Fix)
            const verifyCards = await redis.hGetAll(gameCardsKey);
            const leftovers = Object.entries(verifyCards)
                .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
                .map(([cardId]) => cardId);
                
            if (leftovers.length > 0) {
                console.log(`   -> ⚠️ Worker found leftovers, deleting again: ${leftovers.join(', ')}`);
                await redis.hDel(gameCardsKey, ...leftovers);
                cardsToRelease.push(...leftovers);
            }

            // C) Publish Event
            const cardReleaseEvent = JSON.stringify({
                event: 'cardsReleased', 
                gameId: strGameId,
                cardIds: cardsToRelease, 
                releasedBy: strTelegramId
            });

            await redis.publish('game-events', cardReleaseEvent);
            console.log(`   -> Published 'cardsReleased' event.`);
        }

        // 2. SET CLEANUP: Remove from BOTH sets
        await Promise.all([
            redis.sRem(`gameSessions:${strGameId}`, strTelegramId),
            redis.sRem(`gameRooms:${strGameId}`, strTelegramId)
        ]);
        console.log(`   -> Removed ${strTelegramId} from gameSessions and gameRooms sets.`);

        // 3. Check if empty
        const playerCount = await redis.sCard(`gameRooms:${strGameId}`); 

        if (playerCount === 0) {
            await GameControl.findOneAndUpdate(
                { gameId: strGameId, endedAt: null },
                { $set: { isActive: false, endedAt: new Date(), players: [] } },
                { maxTimeMS: 5000 } 
            );
            
            // Safe Nuke of the key
            await redis.del(gameCardsKey); 
            console.log(`   -> Game ${strGameId} is now empty. Fully cleaned Redis key.`);
            
            const resetEvent = JSON.stringify({
                event: 'fullGameReset', 
                gameId: strGameId,
                gameSessionId: gameSessionId 
            });
            await redis.publish('game-events', resetEvent); 
        }

    } catch (error) {
        console.error(`❌ Error in processLobbyCleanup for ${telegramId}:`, error);
    }
}


// --- Logic for Join Game (Live Game) Phase Cleanup ---
async function processJoinGameCleanup(job, redis) {
    const { telegramId, gameId, gameSessionId } = job;
    console.log(`   -> Executing JOIN_GAME cleanup for ${telegramId}`);

    try {
        // If a game is active, we just mark the player as disconnected.
        await PlayerSession.updateOne(
            { GameSessionId: gameSessionId, telegramId },
            { $set: { status: 'disconnected' } }
        );
        console.log(`   -> Marked ${telegramId} as 'disconnected' in PlayerSession.`);

        // Remove the player from the *live* room count in Redis
        await redis.sRem(`gameRooms:${gameId}`, telegramId);
        console.log(`   -> Removed ${telegramId} from Redis live room.`);

        // Clear user's balance reservation in the DB
        await User.updateOne(
            { telegramId, reservedForGameId: gameId },
            { $unset: { reservedForGameId: "" } }
        );
        console.log(`   -> Cleared balance reservation for ${telegramId}.`);

        // Check if the live game is now empty
        const livePlayerCount = await redis.sCard(`gameRooms:${gameId}`);
        if (livePlayerCount === 0 && gameSessionId !== 'NO_SESSION_ID') {
            const game = await GameControl.findOne({ GameSessionId: gameSessionId, endedAt: null });
            if (game && game.isActive) {
                 // 🚨 CRITICAL FIX: Add { maxTimeMS: 5000 } to prevent indefinite hang
                 await GameControl.updateOne(
                    { GameSessionId: gameSessionId },
                    { $set: { endedAt: new Date() } },
                    { maxTimeMS: 5000 }
                );
                console.log(`   -> All live players left game ${gameId}. Marked game as ended.`);
                 // 🟢 PUBLISH the 'fullGameReset' command to the API server
                const resetEvent = JSON.stringify({
                    event: 'fullGameReset', // Use a specific event name for the full reset
                    gameId: gameId,
                    gameSessionId: gameSessionId
                });
                
                await redis.publish('game-events', resetEvent);
                console.log(`   -> Published 'fullGameReset' event for game ${gameId} to API.`);
            }
        }
    } catch (error) {
        console.error(`❌ Error in processJoinGameCleanup for ${telegramId}:`, error);
    }
}

// --- Global Error Handlers ---
// Prevents the Node.js process from silently crashing on unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION in Worker:', reason);
    // Continue running, let the while(true) loop handle job recovery
});

// Catches synchronous errors that escape all try/catch blocks
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION in Worker:', err);
    // CapRover will restart the container automatically
});

// --- Start the worker process ---
startWorker();