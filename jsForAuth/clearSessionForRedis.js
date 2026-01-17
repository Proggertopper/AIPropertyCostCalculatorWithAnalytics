// require("dotenv").config();
// const redis = require("redis");

// const client = redis.createClient({
//     socket: { host: "127.0.0.1", port: 6379 },
//     password: process.env.REDIS_PASSWORD
// });

// async function clearSessions() {
//     await client.connect();

//     const keys = await client.keys("sess:*");
//     console.log("Found", keys.length, "session keys");

//     if (keys.length > 0) {
//         await client.del(keys);
//         console.log("All session keys deleted");
//     }

//     await client.quit();
// }

// clearSessions();