require("dotenv").config();
const mongoose = require('mongoose');
const { createClient } = require("redis");
const connectDB = require("./config/db");
const http = require('http'); // 🟢 1. Import HTTP module

// Import Mongoose Models
const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameCard = require('./models/GameCard');
const PlayerSession = require("./models/PlayerSession");
const { findFieldsByValue } = require("./utils/redisHelpers");

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
                // This awaits, allowing the event loop to handle HTTP requests in the background
                const result = await redis.brPop('disconnect-cleanup-queue', 0);
                const jobPayload = result.element;
                const job = JSON.parse(jobPayload);

                console.log(`\n▶️  Processing job for User: ${job.telegramId}, Game: ${job.gameId}, Phase: ${job.phase}`);

                // 4. Route the job to the correct cleanup logic based on the phase
                if (job.phase === 'lobby') {
                    await processLobbyCleanup(job, redis);
                } else if (job.phase === 'joinGame') {
                    await processJoinGameCleanup(job, redis);
                     await processLobbyCleanup(job, redis);
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
    const strTelegramId = String(telegramId).trim(); 
    const strGameId = String(gameId);

    
    console.log(`   -> Executing LOBBY cleanup for ${telegramId}`);

    try {
        const gameCardsKey = `gameCards:${strGameId}`;

        const cardsToRelease = await findFieldsByValue(redis, gameCardsKey, strTelegramId);


        if (cardsToRelease.length > 0) {
            console.log(`   -> Found ${cardsToRelease.length} cards in Redis to release: ${cardsToRelease.join(', ')}`);

            await redis.hDel(gameCardsKey, ...cardsToRelease);

            await GameCard.updateMany(
                { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                { $set: { isTaken: false, takenBy: null } }
            );

                // Optional: verify leftovers (you can keep this, but now using HSCAN too)
                const leftovers = await findFieldsByValue(redis, gameCardsKey, strTelegramId);
                if (leftovers.length > 0) {
                    console.warn(`Leftovers after release: ${leftovers.join(', ')}`);
                    await redis.hDel(gameCardsKey, ...leftovers);
                }

            const cardReleaseEvent = JSON.stringify({
                event: 'cardsReleased', 
                gameId: strGameId,
                cardIds: cardsToRelease, 
                releasedBy: strTelegramId
            });

            await redis.publish('game-events', cardReleaseEvent);
            console.log(`   -> Published 'cardsReleased' event.`);
        }

        await Promise.all([
            redis.sRem(`gameSessions:${strGameId}`, strTelegramId),
            redis.sRem(`gameRooms:${strGameId}`, strTelegramId)
        ]);
        console.log(`   -> Removed ${strTelegramId} from gameSessions and gameRooms sets.`);

        const playerCount = await redis.sCard(`gameRooms:${strGameId}`); 

        if (playerCount === 0) {
            await GameControl.findOneAndUpdate(
                { gameId: strGameId, endedAt: null },
                { $set: { isActive: false, endedAt: new Date(), players: [] } },
                { maxTimeMS: 5000 } 
            );
            
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


// --- Logic for Join Game Phase Cleanup ---
async function processJoinGameCleanup(job, redis) {
    const { telegramId, gameId, gameSessionId } = job;
    console.log(`   -> Executing JOIN_GAME cleanup for ${telegramId}`);

    try {
        await PlayerSession.updateOne(
            { GameSessionId: gameSessionId, telegramId },
            { $set: { status: 'disconnected' } }
        );
        console.log(`   -> Marked ${telegramId} as 'disconnected' in PlayerSession.`);

        await redis.sRem(`gameRooms:${gameId}`, telegramId);
        console.log(`   -> Removed ${telegramId} from Redis live room.`);

        await User.updateOne(
            { telegramId, reservedForGameId: gameId },
            { $unset: { reservedForGameId: "" } }
        );
        console.log(`   -> Cleared balance reservation for ${telegramId}.`);

        const livePlayerCount = await redis.sCard(`gameRooms:${gameId}`);
        if (livePlayerCount === 0 && gameSessionId !== 'NO_SESSION_ID') {
            const game = await GameControl.findOne({ GameSessionId: gameSessionId, endedAt: null });
            if (game && game.isActive) {
                 await GameControl.updateOne(
                    { GameSessionId: gameSessionId },
                    { $set: { endedAt: new Date() } },
                    { maxTimeMS: 5000 }
                );
                console.log(`   -> All live players left game ${gameId}. Marked game as ended.`);
                const resetEvent = JSON.stringify({
                    event: 'fullGameReset', 
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
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION in Worker:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION in Worker:', err);
});

// 🟢 2. CREATE A DUMMY SERVER TO SATISFY RENDER PORT BINDING
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Cleanup Worker is Running and Healthy!\n');
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`✅ Dummy HTTP Server listening on port ${PORT}...`);
    // 🟢 3. Start the actual worker logic AFTER the server listens
    startWorker();
});