const db = require("./db");
const tokens = require("./tokens");

module.exports = app => {


    app.post("/api/app/calculation", async (req, res) => {
        if (!req.session.userId) return res.sendStatus(401);

        const csrfToken = req.headers["x-csrf-token"];
        const secret = req.session.csrfSecret;

        if (!secret || !csrfToken || !tokens.verify(secret, csrfToken)) {
            return res.status(403).json({ error: "Invalid CRSF token" });
        }

        const { calculatorType, inputData, resultData } = req.body;
        // console.log("POST /calculation payload:", { calculatorType, inputData, resultData });

        if (!calculatorType || !inputData || !resultData) {
            return res.status(400).json({ error: "Invalid payload" })
        }

        await db.query(`INSERT INTO calculations (user_id , calculator_type , input_data , result_data) 
                VALUES ($1 , $2 , $3, $4)` , [req.session.userId, calculatorType, inputData, resultData]);

        res.json({ ok: true });

    });


    app.get("/api/app/calculations", async (req, res) => {
        if (!req.session.userId) return res.sendStatus(401);

        const { rows } = await db.query(`SELECT id, calculator_type , input_data , result_data , created_at
                FROM calculations
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 50
                `, [req.session.userId]);

        // console.log("GET /calculations rows:", rows);
        

        res.json(rows);
    });

    app.get("/api/app/calculation/:id", async (req, res) => {
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

    app.delete("/api/app/calculation/:id" , async (req , res) => {
        if(!req.session.userId) return res.sendStatus(401);

        const {id} = req.params;

         await db.query(
            `DELETE FROM calculations WHERE id=$1 and user_id=$2` , [id, req.session.userId]
        );

        res.json({ok:true});
    });



};