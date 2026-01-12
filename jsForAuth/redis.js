require("dotenv").config();
const { createClient } = require("redis");

const redisClient = createClient({
    socket: {
        host: "127.0.0.1",
        port: 6379
    },
    password: process.env.REDIS_PASSWORD
});

redisClient.on("error", err => {
    console.error("Redis error", err);
});

redisClient.connect();

module.exports = redisClient;