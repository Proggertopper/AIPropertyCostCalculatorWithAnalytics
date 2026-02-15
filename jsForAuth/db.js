// require("dotenv").config();
// const fs = require("fs");
// const { Pool } = require("pg");


// const pool = new Pool({
//     connectionString: process.env.DATABASE_URL,
//     ssl: {
//         ca: fs.readFileSync(process.env.PG_CA_PATH, "utf8"),
//         rejectUnauthorized: false,
//     },
// });

// if (!process.env.DATABASE_URL) {
//     throw new Error("Postgres is not set in environment");
// }

// module.exports = pool;

require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set in environment");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl : true,
});

module.exports = pool;


