const GameControl = require("../models/GameControl");
const PlayerSession = require("../models/PlayerSession");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey, getGameSessionsKey, getGamePlayersKey } = require("./redisKeys");

async function resetGame(gameId, strGameSessionId,  io,  state, redis) {
    const strGameId = String(gameId);
    console.log("inside reset Game gamesessionid🤪🤪", strGameSessionId);
    const {
        drawIntervals,
        countdownIntervals,
        drawStartTimeouts,
        activeDrawLocks,
        gameDraws,
        gameSessionIds,
        gameIsActive,
        gamePlayers,
        userSelections, // Not used here for Redis cleanup, as handled elsewhere or removed
    } = state;

    console.log(`🧹 Starting full reset for game ${gameId}`);

    await PlayerSession.deleteMany({ GameSessionId: strGameSessionId });
    console.log(`✅ All PlayerSession records for session ${strGameSessionId} deleted. resetGame`);

    // 🛠 1. Update GameControl in MongoDB
    try {
        const updatedGame = await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId },
                { $set: { isActive: false, endedAt: new Date() } },
                { new: true }
            );
            console.log("Updated GameControl:", updatedGame);
        console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
    } catch (err) {
        console.error(`❌ Failed to reset GameControl for ${gameId}:`, err);
    }

    // 📢 2. Notify clients
    io?.to(gameId).emit("gameEnded");


    // ⏱ 3. Clear timeouts/intervals
  if (state?.countdownIntervals?.[strGameId]) {
        clearInterval(state.countdownIntervals[strGameId]);
        delete state.countdownIntervals[strGameId];
    }
    if (state?.drawIntervals?.[strGameId]) {
        clearInterval(state.drawIntervals[strGameId]);
        delete state.drawIntervals[strGameId];
    }
    if (state?.drawStartTimeouts?.[strGameId]) {
        clearTimeout(state.drawStartTimeouts[strGameId]);
        delete state.drawStartTimeouts[strGameId];
    }
    if (state?.activeDrawLocks?.[strGameId]) {
        delete state.activeDrawLocks[strGameId];
    }

    // 🧠 4. Clear in-memory state
    delete activeDrawLocks?.[gameId];
    delete gameDraws?.[gameId];
    delete gameSessionIds?.[gameId];
    delete gameIsActive?.[gameId];
    delete gamePlayers?.[gameId]; // Clear this in-memory map/object entry
    console.log(`🧹 In-memory state for game ${gameId} cleared.`);


    // 🗑️ 5. Redis cleanup for game-specific keys
    try {
        await Promise.all([
        redis.set(`gameIsActive:${gameId}`, "false"),
        redis.del(getGameDrawsKey(strGameSessionId)),
        redis.del(getGameDrawStateKey(strGameId)),
        redis.del(getGameDrawsKey(strGameSessionId)),
        redis.del(getActiveDrawLockKey(strGameId)),
        redis.del(getGameSessionsKey(strGameId)),
        redis.del(getGameRoomsKey(strGameId)),
        redis.del(getGameActiveKey(strGameId)),
        redis.del(`gameSessionId:${strGameId}`),
    ]);
        console.log(`✅ Core Redis game keys for ${gameId} cleared.`);
          
    // 🧹 Clean up any pending disconnect timeouts related to this game
        for (const [key, timeoutId] of pendingDisconnectTimeouts.entries()) {
            if (key.includes(`${strGameId}:`)) {   // Only remove ones tied to this game
                clearTimeout(timeoutId);
                pendingDisconnectTimeouts.delete(key);
                console.log(`🧹 Cleared pending disconnect timeout reset Game: ${key}`);
            }
        }


    } catch (redisErr) {
        console.error(`❌ Redis cleanup error for game ${gameId}:`, redisErr);
    }

    console.log(`🧼 Game ${gameId} has been fully reset.`);
}

module.exports = resetGame;