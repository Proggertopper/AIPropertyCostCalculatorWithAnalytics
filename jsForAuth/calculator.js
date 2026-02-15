const db = require("./db");
const tokens = require("./tokens");
const makeRateLimit = require("./rateLimit");
const redisClient = require("./redis");
const { computeResultByType } = require("./compute");

const rl = makeRateLimit(redisClient);

function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

function enrichResultDataForStorage(calculatorType, inputData, canonicalResult) {
    const out = { ...(canonicalResult || {}) };

    if (calculatorType === "ownership_cost") {
        const price = Number(inputData?.price || 0);
        const years = Math.trunc(Number(inputData?.years || 0));
        const total = Number(out.totalOwnershipCost ?? out.totalCost ?? 0);
        const totalPV = Number(out.totalOwnershipCostPV ?? out.totalCostPV ?? 0);

        if (Number.isFinite(years) && years > 0) out.years = years;
        if (Number.isFinite(total)) {
            out.totalOwnershipCost = Math.round(total);
            out.totalCost = Math.round(total);
        }
        if (Number.isFinite(totalPV)) {
            out.totalOwnershipCostPV = Math.round(totalPV);
            out.totalCostPV = Math.round(totalPV);
        }
        if (Number.isFinite(price) && price > 0 && Number.isFinite(total)) {
            out.costAsPercentOfPrice = Math.round((total / price) * 10000) / 100;
        }
    }

    return out;
}

module.exports = app => {

    app.post("/api/app/calculation", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
        if (!req.session.userId) return res.sendStatus(401);

        const csrfToken = req.headers["x-csrf-token"];
        const secret = req.session.csrfSecret;

        if (!secret || !csrfToken || !tokens.verify(secret, csrfToken)) {
            return res.status(403).json({ error: "Invalid CSRF token" });
        }

        const { calculatorType, inputData, resultData } = req.body;

        if (!calculatorType || !isPlainObject(inputData) || !isPlainObject(resultData)) {
            return res.status(400).json({ error: "Invalid payload" })
        }

        const canonicalResult = computeResultByType(calculatorType, inputData);
        if (!canonicalResult) {
            return res.status(400).json({ error: "INVALID_CALC_INPUT" });
        }

        const resultToStore = enrichResultDataForStorage(calculatorType, inputData, canonicalResult);

        await db.query(`INSERT INTO calculations (user_id , calculator_type , input_data , result_data) 
                VALUES ($1 , $2 , $3, $4)` , [req.session.userId, calculatorType, inputData, resultToStore]);

        res.json({ ok: true });

    });


    app.get("/api/app/calculations", rl.byUser({ limit: 120, windowSec: 600 }), async (req, res) => {
        if (!req.session.userId) return res.sendStatus(401);

        const { rows } = await db.query(`SELECT id, calculator_type , input_data , result_data , created_at
                FROM calculations
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 50
                `, [req.session.userId]);

        
        

        res.json(rows);
    });

    app.get("/api/app/calculation/:id", rl.byUser({ limit: 180, windowSec: 600 }), async (req, res) => {
        if (!req.session.userId) return res.sendStatus(401);

        const { id } = req.params;

        const { rows } = await db.query(
            `SELECT id, calculator_type , input_data , result_data
         FROM calculations
         WHERE id = $1 AND user_id = $2`,
            [id, req.session.userId]
        );

        if (!rows.length) return res.sendStatus(404);

        res.json(rows[0]);
    });

    app.delete("/api/app/calculation/:id", rl.byUser({ limit: 90, windowSec: 600 }), async (req, res) => {
        if(!req.session.userId) return res.sendStatus(401);

        const {id} = req.params;

         await db.query(
            `DELETE FROM calculations WHERE id=$1 and user_id=$2` , [id, req.session.userId]
        );

        res.json({ok:true});
    });



};
