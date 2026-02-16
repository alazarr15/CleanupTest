async function findFieldsByValue(redis, hashKey, targetOwnerId, batchSize = 100) {
  const matchingFields = [];
  let cursor = '0';

  do {
    // Correct usage: get the result object
    const scanResult = await redis.hScan(hashKey, cursor, {
      MATCH: '*',
      COUNT: batchSize
    });

    // Access properties correctly
    cursor = scanResult.cursor;
    const entries = scanResult.entries || [];   // flat array: [field1, value1, field2, value2, ...]

    for (let i = 0; i < entries.length; i += 2) {
      const field = entries[i];
      const value = entries[i + 1];

      if (String(value).trim() === targetOwnerId) {
        matchingFields.push(field);
      }
    }
  } while (cursor !== '0');

  return matchingFields;
}

module.exports = {
  findFieldsByValue
};