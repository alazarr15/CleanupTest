// utils/redisKeys.js

function getGameActiveKey(gameId) {
    return `gameActive:${gameId}`;
}

function getActivePlayers(strGameSessionId){
     return `activePlayers:${strGameSessionId}`;
}

function getGameActiveKeys(gameId) {
    return `gameIsActive:${gameId}`;
}

function getCountdownKey(gameId) {
    return `countdown:${gameId}`;
}

function getActiveDrawLockKey(gameId) {
    return `activeDrawLock:${gameId}`;
}

function getGameDrawStateKey(gameId) {
    return `gameDrawState:${gameId}`;
}

function getGameDrawsKey(strGameSessionId) {
    return `gameDraws:${strGameSessionId}`;
}

function getGameSessionsKey(gameId) {
    return `gameSessions:${gameId}`; // Represents the lobby/card selection
}

function getGamePlayersKey(gameId) {
    return `gamePlayers:${gameId}`; // Overall players for the game instance
}

function getGameRoomsKey(gameId) {
    return `gameRooms:${gameId}`; // Players currently in the active game room
}

function getCardsKey(strGameId) {
    return `gameCards:${strGameId}`; // Players currently in the active game room
}

// Add any other Redis key helpers you might need
function getUserBalanceKey(telegramId) {
    return `userBalance:${telegramId}`;
}

function getActiveSocketKey(telegramId, socketId) {
    return `activeSocket:${telegramId}:${socketId}`;
}


module.exports = {
    getGameActiveKey,
    getGameActiveKeys,
    getCountdownKey,
    getActiveDrawLockKey,
    getGameDrawStateKey,
    getGameDrawsKey,
    getGameSessionsKey,
    getGamePlayersKey,
    getGameRoomsKey,
    getUserBalanceKey,
    getActiveSocketKey,
    getCardsKey,
    getActivePlayers
};