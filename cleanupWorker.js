require("dotenv").config();
const mongoose = require('mongoose');
const { createClient } = require("redis");
const connectDB = require("./config/db");

// Import Mongoose Models
const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameCard = require('./models/GameCard');
const PlayerSession = require("./models/PlayerSession");
const resetGame = require("./utils/resetGame"); // Assuming this utility doesn't need `io` or `socket`

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
                // The '0' means it will wait indefinitely.
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


// --- Logic for Lobby Phase Cleanup ---
    async function processLobbyCleanup(job, redis) {
        const { telegramId, gameId, gameSessionId } = job;
        console.log(`   -> Executing LOBBY cleanup for ${telegramId}`);

        // 1. Release card in DB and Redis
        const dbCard = await GameCard.findOneAndUpdate(
            { gameId, takenBy: telegramId },
            { $set: { isTaken: false, takenBy: null } },
            { new: true }
        );

        if (dbCard) {
            // ✅ Ensure this is awaited
            await redis.hDel(`gameCards:${gameId}`, String(dbCard.cardId)); 
            console.log(`   -> Card ${dbCard.cardId} released.`);
        }

        // 2. Check if the lobby is now completely empty
        // ✅ Ensure redis.sCard is awaited
        const playerCount = await redis.sCard(`gamePlayers:${gameId}`); 

        if (playerCount === 0) {
            
            // 3. Update GameControl in DB (Mark as ended)
            // ✅ Ensure this is awaited
            await GameControl.findOneAndUpdate(
                { gameId, endedAt: null },
                { $set: { isActive: false, endedAt: new Date(), players: [] } }
            );
            
            // 4. Cleanup Redis keys specific to the lobby phase
            // ✅ Ensure this is awaited
            await redis.del(`gameCards:${gameId}`); 
            console.log(`   -> Game ${gameId} is now empty and has been marked as ended in DB.`);
            
            // 5. PUBLISH the 'fullGameReset' command to the API server
            const resetEvent = JSON.stringify({
                event: 'fullGameReset', // The signal caught by index.js
                gameId: gameId,
                gameSessionId: gameSessionId 
            });
            
            // ✅ Ensure this is awaited
            await redis.publish('game-events', resetEvent); 
            console.log(`   -> Published 'fullGameReset' event for game ${gameId} to API.`);
        }
    }


// --- Logic for Join Game (Live Game) Phase Cleanup ---
async function processJoinGameCleanup(job, redis) {
    const { telegramId, gameId, gameSessionId } = job;
    console.log(`   -> Executing JOIN_GAME cleanup for ${telegramId}`);

    // If a game is active, we just mark the player as disconnected.
    // They are still a part of the game's history and records.
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
             await GameControl.updateOne(
                { GameSessionId: gameSessionId },
                { $set: { endedAt: new Date() } }
            );
            console.log(`   -> All live players left game ${gameId}. Marked game as ended.`);
             // 2. 🟢 PUBLISH the 'fullGameReset' command to the API server
        const resetEvent = JSON.stringify({
            event: 'fullGameReset', // Use a specific event name for the full reset
            gameId: gameId,
            gameSessionId: gameSessionId // Pass all data needed for the remote function
        });
        
        // Use the Redis client connected in the worker to publish
        await redis.publish('game-events', resetEvent);
        console.log(`   -> Published 'fullGameReset' event for game ${gameId} to API.`);
        }
    }
}

// --- Start the worker process ---
startWorker();
