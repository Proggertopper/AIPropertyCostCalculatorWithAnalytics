require("dotenv").config();

const { createClient } = require("redis");

const redisClient = createClient({
    url: process.env.REDIS_URL,
});

redisClient.on("error", (err) => {
    console.error("Redis error:", err);
});

if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set in environment");
}

(async () => {
    try {
        await redisClient.connect();
    } catch (e) {
        console.error("Redis connect failed:", e);
        process.exit(1);
    }
})();

module.exports = redisClient;
